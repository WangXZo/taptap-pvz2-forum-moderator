// T15 测试（2026-11-20）：发送后直查复核 + 「我们发过的评论 id 清单」
//
// 背景：
//   ① 以前判断「玩家这条是不是在回我们」靠**当轮评论列表按作者 id 反查**，
//      而我们的子回复常不在列表里（旧接口 child_posts 只返 2 条）→ 漏判 → 不接话。
//   ② 发送后想确认「发出去了」靠**模糊搜文本** → 折叠的子回复搜不到 → 永远「未校验到」。
//   现在：发送时把我们自己那条评论的 id 落库，按 id 查，跨轮次也在。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ourSentCommentIds, sentCommentRecorded, markDoneEvent } from './lib/post-records.mjs';

let fail = 0;
function t(name, cond, extra = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { fail++; console.log(`  FAIL ${name}${extra ? `  ${extra}` : ''}`); }
}

const dir = mkdtempSync(join(tmpdir(), 't15-'));
const db = openDb(join(dir, 'rec.sqlite'));

console.log('\n== ourSentCommentIds：从 post_event 里取我们自己发的评论 id ==');
{
  t('空库 → 空集合', ourSentCommentIds(db, 'P1').size === 0);

  markDoneEvent(db, 'P1', 'praise_reply', { commentId: 'C_TARGET', sentCommentId: '405700001', text: '夸' });
  markDoneEvent(db, 'P1', 'interact_reply', { commentId: 'C_TARGET2', sentCommentId: '405700002', text: '接话' });
  markDoneEvent(db, 'P1', 'share_reply', { commentId: 'C_TARGET3', text: '分享互动（没有 sentCommentId）' });

  const ids = ourSentCommentIds(db, 'P1');
  t('取到 2 个 id', ids.size === 2, `实际 ${ids.size}`);
  t('含 405700001', ids.has('405700001'));
  t('含 405700002', ids.has('405700002'));
  t('没有 sentCommentId 的不算', !ids.has('C_TARGET3'));
  t('不会把「被回复的 id」当成我们发的', !ids.has('C_TARGET'), [...ids].join(','));
}

{
  // 别的帖不串
  markDoneEvent(db, 'P2', 'praise_reply', { sentCommentId: '405999999' });
  const p1 = ourSentCommentIds(db, 'P1');
  const p2 = ourSentCommentIds(db, 'P2');
  t('P1 不含 P2 的', !p1.has('405999999'));
  t('P2 只有一个', p2.size === 1 && p2.has('405999999'));
}

console.log('\n== sentCommentRecorded：按 id 直查落库 ==');
{
  t('已落库的 id → true', sentCommentRecorded(db, 'P1', '405700001') === true);
  t('不存在的 id → false', sentCommentRecorded(db, 'P1', '405777777') === false);
  t('空 id → false', sentCommentRecorded(db, 'P1', '') === false);
  t('空 db → false', sentCommentRecorded(null, 'P1', '405700001') === false);
}

console.log('\n== 边界：坏数据不炸 ==');
{
  // detail 不是合法 JSON
  const { DatabaseSync } = await import('node:sqlite');
  const db2 = openDb(join(dir, 'rec2.sqlite'));
  db2.prepare("INSERT INTO post_event (post_id, ts, kind, detail) VALUES (?, ?, ?, ?)").run('P3', Date.now(), 'praise_reply', 'not-json');
  const ids = ourSentCommentIds(db2, 'P3');
  t('坏 JSON 被跳过', ids.size === 0);
  t('坏 JSON 不抛', true);
  db2.close();
}

console.log('\n== 无 db 也不炸 ==');
{
  t('ourSentCommentIds(null) → 空集合', ourSentCommentIds(null, 'P1').size === 0);
  t('ourSentCommentIds(db, "") → 空集合', ourSentCommentIds(db, '').size === 0);
  t('sentCommentRecorded(null) → false', sentCommentRecorded(null, 'P1', 'x') === false);
}

db.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 可能还锁着 */ }
console.log(fail ? `\n✗ ${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);