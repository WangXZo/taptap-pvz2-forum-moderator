#!/usr/bin/env node
// 帖子记录层（SQLite）单测
//
// 盯三件事：
//   1) 逐行写：同一条帖子多次更新不会丢别的字段
//   2) 幂等：库里记着「处理过」，state.json 丢了也不会重复处理
//   3) 搬库：老记录从 state.json 搬到 SQLite（搬，不是丢），且待回复/需人工的**不能**被搬走

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, listPosts, listEvents, stats, prunePosts } from './lib/db.mjs';
import { recordScanned, recordModScanned, recordStatus, isHandled, archiveOldPosts } from './lib/post-records.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => (cond ? pass++ : fails.push(`${name} ${extra}`));

const dir = mkdtempSync(join(tmpdir(), 'postrec-'));
const db = openDb(join(dir, 'rec.sqlite'));

// ---------- 逐行 upsert ----------
recordScanned(db, { id: '111', title: '加好友', author: '甲', url: 'u1', publishTime: 1700000000 }, {
  board: '40173:feed',
  status: 'detected',
  keyword: '加好友',
});
ok('写进去一条', listPosts(db).length === 1);
ok('标题对', listPosts(db)[0].title === '加好友');
ok('关键词对', listPosts(db)[0].keyword === '加好友');

recordStatus(db, '111', 'replied', { stage: 'replied', keyword: '加好友' });
recordStatus(db, '111', 'removed', { stage: 'removed' });
const r1 = listPosts(db)[0];
ok('重复更新不丢字段（关键词还在）', r1.keyword === '加好友', JSON.stringify(r1));
ok('状态更新为 removed', r1.status === 'removed');
ok('事件流水有 2 条', listEvents(db, '111').length === 2, String(listEvents(db, '111').length));

// ---------- 幂等 ----------
ok('库里有终态 → 算处理过', isHandled(db, { posts: {} }, '111'));
ok('库里没有 → 不算处理过', !isHandled(db, { posts: {} }, '222'));
ok(
  'state.json 里有 modTask.removedAt → 算处理过',
  isHandled(db, { posts: { '333': { modTask: { removedAt: 'x' } } } }, '333')
);

// ---------- 搬库 ----------
const old = Date.now() - 60 * 86400000;
const state = {
  posts: {
    old1: { status: 'replied', title: '老的已回复', updatedAt: new Date(old).toISOString(), normKey: 'k1' },
    old2: { status: 'no_need', title: '老的无需回复', updatedAt: new Date(old).toISOString() },
    keep1: { status: 'pending', title: '待回复的', updatedAt: new Date(old).toISOString() },
    keep2: { status: 'manual', title: '需人工的', updatedAt: new Date(old).toISOString() },
    fresh: { status: 'replied', title: '新的已回复', updatedAt: new Date().toISOString() },
  },
};
const arch = archiveOldPosts(state, db, { olderThanDays: 45 });
ok('搬走 2 条老记录', arch.moved === 2, JSON.stringify(arch));
ok('老的已回复从 state.json 消失', !state.posts.old1);
ok('老的无需回复从 state.json 消失', !state.posts.old2);
ok('待回复的留在 state.json', Boolean(state.posts.keep1));
ok('需人工的留在 state.json', Boolean(state.posts.keep2));
ok('新的留在 state.json', Boolean(state.posts.fresh));
const rows = listPosts(db);
ok('库里能查到搬来的记录', rows.some((r) => r.title === '老的已回复'));
ok(
  '搬来的记录带 normKey',
  rows.find((r) => r.title === '老的已回复')?.detail?.includes('normKey')
);

// ---------- 管理任务的终态保护 ----------
// 已移除的帖子再被扫到，状态**不能**退回 'scanned' —— 否则下一轮会重复回复+重复移除
recordModScanned(db, { id: 'g1', title: '已移除的帖' }, { status: 'detected' });
recordStatus(db, 'g1', 'removed', { stage: 'removed' });
recordModScanned(db, { id: 'g1', title: '已移除的帖' }, { status: 'scanned' });
ok('终态不被后续扫描覆盖', listPosts(db).find((r) => r.id === 'g1')?.status === 'removed', JSON.stringify(listPosts(db).find((r) => r.id === 'g1')));
ok('终态帖子仍算处理过', isHandled(db, { posts: {} }, 'g1'));

// ---------- 答疑守护与管理任务各写各的列 ----------
recordScanned(db, { id: 'h1', title: '两边都扫到' }, { qaStatus: 'no_need' });
recordModScanned(db, { id: 'h1', title: '两边都扫到' }, { status: 'detected' });
const both = listPosts(db).find((r) => r.id === 'h1');
ok('答疑判定写 qa_status', both?.qa_status === 'no_need', JSON.stringify(both));
ok('管理任务状态写 status', both?.status === 'detected', JSON.stringify(both));

// ---------- 统计与裁剪 ----------
const s = stats(db);
ok('统计总数正确', s.total === 5, String(s.total)); // 111 + old1 + old2 + g1 + h1
const pruned = prunePosts(db, { olderThanDays: 45, keepStatuses: [] });
ok('裁剪掉了老记录', pruned.pruned >= 2, String(pruned.pruned));
ok('裁剪后事件流水里有记录', listEvents(db, 'old1').length >= 1);

try {
  db.close();
} catch {}
try {
  rmSync(dir, { recursive: true, force: true });
} catch {}

console.log(`\n通过 ${pass} 条`);
if (fails.length) {
  console.log(`失败 ${fails.length} 条：`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过 ✓');
