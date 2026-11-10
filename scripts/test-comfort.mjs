#!/usr/bin/env node
// 纯情绪帖安慰通道 回归测试（2026-11-10）
//
// 来历：两条真实帖子掉进了「需人工」，一句话都没人回 ——
//   · 《我无疑是绝望的。。。》          任务差一点没完成
//   · 《我想知道玩这个游戏的...》       被谐音脏话昵称「你老牧师了」恶心到
// 它们既不是提问（答疑库答不了），又没有「终于/到手/集齐」这些分享特征（looksLikeShare 不认），
// 于是两头都不占。这里锁三件事：
//   1) 该安慰的认得出来（含这两条真实文本）
//   2) 不该插话的一律不碰（维权/加好友/寻码/真提问/正常分享）
//   3) **一帖一次** —— 凭据落 post_event，记录被剪枝搬库后仍然挡得住
//
//   node scripts/test-comfort.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { looksLikeEmotion, looksLikeShare, looksLikeQuestion } from './lib/qa.mjs';
import { openDb } from './lib/db.mjs';
import { recordScanned, hasDoneEvent, markDoneEvent, isHandled } from './lib/post-records.mjs';

let pass = 0;
const fails = [];
const t = (name, cond, extra = '') => (cond ? pass++ : fails.push(`${name} ${extra}`));

// ---------- 1. 真实事故帖：必须认出来 ----------
console.log('== 真实事故帖 ==');
const REAL = [
  ['我无疑是绝望的。。。', '任务差一点，无法完成了。非常可惜'],
  [
    '我想知道玩这个游戏的...',
    '我想知道玩这个游戏的都是什么年龄段的人，上来就"你老牧师了"，上一次还有"对面乐子自己退"没截屏，取这种名字干嘛呢，恶心人我承认你确实恶心到了，现在的人都这样吗',
  ],
];
for (const [title, body] of REAL) {
  t(`认得出：${title.slice(0, 14)}`, looksLikeEmotion(`${title}\n${body}`));
}

// ---------- 2. 其它情绪表达 ----------
console.log('\n== 其它情绪表达 ==');
for (const s of [
  '白肝了三个月算是白玩',
  '就差一片，气死我了',
  '这波血亏，心疼我的钻石',
  '又闪退，麻了不想玩了',
  '太可惜了真的很不甘心',
  '被对面起名字膈应到了，窝火',
]) {
  t(`认得出：${s.slice(0, 12)}`, looksLikeEmotion(s));
}

// ---------- 3. 不该插话的一律不碰 ----------
console.log('\n== 不该插话 ==');
const MUST_NOT = [
  ['维权', '我要退款，客服一直不理我，太失望了'],
  ['举报', '这人在骂我，我要举报，很难受'],
  ['封号', '莫名其妙被封号了，很崩溃'],
  ['加好友', '求加好友啊 andF59E744B 好友位空了'],
  ['寻码', '有没有天宫码 JFAABCDEFG 挺难受的'],
  ['真提问', '困难6怎么过，被打得很崩溃'],
  ['正常分享', '终于拿到猕猴桃超装了！！！'],
  ['无情绪', '今天天气不错，出来晒晒太阳'],
];
for (const [why, s] of MUST_NOT) {
  t(`不碰（${why}）`, !looksLikeEmotion(s), s.slice(0, 20));
}

// ---------- 4. 与其它判定不冲突 ----------
console.log('\n== 与其它判定并存 ==');
t('情绪帖 → 不是分享（所以分享通道接不了）', !looksLikeShare('我无疑是绝望的。。。'));
t('情绪帖 → 提问判定可能为真（所以会掉进需人工）', looksLikeQuestion('我想知道玩这个游戏的...') !== undefined);
t('分享帖 → 不是情绪帖（走 3d 分享互动）', !looksLikeEmotion('终于拿到猕猴桃超装了！！！'));

// ---------- 5. 一帖一次：凭据落库、搬库后仍然挡得住 ----------
console.log('\n== 一帖一次（持久幂等）==');
const dir = mkdtempSync(join(tmpdir(), 'comfort-'));
const db = openDb(join(dir, 'c.sqlite'));
{
  const id = '869044017659120193';
  recordScanned(db, { id, title: '我无疑是绝望的。。。', url: 'u' }, { qaStatus: 'manual' });
  t('没安慰过 → 门是开的', !hasDoneEvent(db, id, 'comfort_reply'));
  markDoneEvent(db, id, 'comfort_reply', { text: '别太自责', at: '2026-11-10T00:00:00Z' });
  t('安慰过 → 门关上（第二轮到不了第 3d-2 步）', hasDoneEvent(db, id, 'comfort_reply'));
  // state.posts 里没有这条记录（被剪枝搬库了）—— 这是事故的原始条件
  t('state 里没有这条记录，仍然挡得住', hasDoneEvent(db, '869044017659120193', 'comfort_reply'));
  t('不误伤互动通道（互动用 interact_reply）', !hasDoneEvent(db, id, 'interact_reply'));
  t('不误伤分享通道（分享用 share_reply）', !hasDoneEvent(db, id, 'share_reply'));
  // 楼主继续回复 → 互动通道可以针对那条回复再回（按 commentId 去重）
  markDoneEvent(db, id, 'interact_reply', { commentId: 'C1', hash: 'h1' });
  t(
    '楼主回了第 1 条 → 记下来',
    hasDoneEvent(db, id, 'interact_reply', { key: 'commentId', value: 'C1' })
  );
  t(
    '楼主又回第 2 条 → 仍然可以再回',
    !hasDoneEvent(db, id, 'interact_reply', { key: 'commentId', value: 'C2' })
  );
  t('安慰过的帖算「处理过」（不再当新帖入队）', isHandled(db, { posts: {} }, id));
}
try {
  db.close();
} catch {}
try {
  rmSync(dir, { recursive: true, force: true });
} catch {}

console.log(`\n通过 ${pass} / ${pass + fails.length}`);
if (fails.length) {
  console.log(`失败 ${fails.length} 条：`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过 ✓');