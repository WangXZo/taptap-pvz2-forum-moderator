// O9 state 剪枝单测（2026-11-19）：阈值生效 + 凭据帖不剪 + 搬库不丢信息
import { pruneStatePosts } from './lib/post-records.mjs';
import { openDb, getPost } from './lib/db.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

const dir = mkdtempSync(join(tmpdir(), 'prune-'));
const db = openDb(join(dir, 'rec.sqlite'));

function makeState(n) {
  const posts = {};
  const base = Date.parse('2026-11-19T00:00:00Z');
  for (let i = 0; i < n; i++) {
    posts['p' + i] = {
      title: '帖' + i,
      url: 'https://x/' + i,
      status: 'replied',
      lastSeen: new Date(base - i * 60000).toISOString(), // i 越大越旧
    };
  }
  return { posts };
}

console.log('\n== 未超限不剪 ==');
{
  const st = makeState(10);
  const r = pruneStatePosts(st, db, { keepMax: 300 });
  t('不剪', r.moved === 0 && Object.keys(st.posts).length === 10);
}

console.log('\n== 超限按时间剪到 keepMax ==');
{
  const st = makeState(400);
  const r = pruneStatePosts(st, db, { keepMax: 300 });
  t('剪掉 100 条', r.moved === 100, 'moved=' + r.moved);
  t('保留 300 条', Object.keys(st.posts).length === 300);
  t('保留的是较新的（p0 在）', Boolean(st.posts.p0));
  t('最旧的 p399 被剪', !st.posts.p399);
  t('搬库不丢：库里有 p399', Boolean(getPost(db, 'p399')));
}

console.log('\n== 未处理完/带凭据的不剪 ==');
{
  const st = makeState(400);
  st.posts.p398 = { ...st.posts.p398, status: 'pending' };              // 待回复
  st.posts.p397 = { ...st.posts.p397, status: 'manual' };               // 需人工
  st.posts.p396 = { ...st.posts.p396, summonPending: true };            // 喊话待办
  st.posts.p395 = { ...st.posts.p395, interactPending: true };          // 互动待办
  st.posts.p394 = { ...st.posts.p394, chatterStop: { why: '刷屏' } };   // 刹车标记
  const r = pruneStatePosts(st, db, { keepMax: 300 });
  t('pending 保留', Boolean(st.posts.p398));
  t('manual 保留', Boolean(st.posts.p397));
  t('summonPending 保留（防重复回复）', Boolean(st.posts.p396));
  t('interactPending 保留', Boolean(st.posts.p395));
  t('chatterStop 保留', Boolean(st.posts.p394));
  t('总数为 300（凭据帖占额度）', Object.keys(st.posts).length === 300);
  t('仍然剪了 100 条', r.moved === 100);
}

console.log('\n== 空/异常输入 ==');
{
  t('空 state 不崩', pruneStatePosts({}, db, { keepMax: 10 }).moved === 0);
  t('无 posts 不崩', pruneStatePosts(null, db, { keepMax: 10 }).kept === 0);
}
try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);