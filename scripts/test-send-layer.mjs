// B4-0 send-layer 离线测试（2026-11-19）：空正文/幂等门/四类 kind 分派/成功后记账/失败透明。
import { createSendLayer } from './lib/send-layer.mjs';
import { openDb, listEvents } from './lib/db.mjs';
import { hasDoneEvent } from './lib/post-records.mjs';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

const dir = mkdtempSync(join(tmpdir(), 'sendlayer-'));
const db = openDb(join(dir, 'rec.sqlite'));
const reportsDir = join(dir, 'reports');
mkdirSync(reportsDir, { recursive: true });
const config = { paths: { reportsDir }, reply: { nestedVia: 'api' }, trace: { enabled: true } };

/** stub 底层：记录被调用的函数与参数 */
function makeStubs({ ok = true, stage = 'send' } = {}) {
  const calls = [];
  const rec = (name) => async (args) => { calls.push({ name, args }); return ok ? { ok: true, stage, detail: { emojis: ['开心'] } } : { ok: false, stage: 'fail_x', detail: {} }; };
  return { calls, replyOne: rec('replyOne'), sendPraise: rec('sendPraise'), sendSummonReply: rec('sendSummonReply'), sendInteractReply: rec('sendInteractReply') };
}
const mkState = () => ({ posts: { p1: {} }, recentReplies: {} });
const usage = { items: {} };

console.log('\n== 空正文拦截 ==');
{
  const s = makeStubs();
  const layer = createSendLayer(s);
  const r = await layer.send({ kind: 'answer', postId: 'p1', url: 'u', text: '   ' }, { config, state: mkState(), db });
  t('返回 skipped/empty', r.skipped === true && r.reason === 'empty');
  t('未调用底层', s.calls.length === 0);
}

console.log('\n== 幂等预检 ==');
{
  const s = makeStubs();
  const layer = createSendLayer(s);
  const plan = { kind: 'praise', postId: 'p1', url: 'u', text: '夸一句', commentId: 'c1', done: { kind: 'praise_reply', key: 'commentId', value: 'c1' } };
  const ctx = { config, state: mkState(), db };
  const r1 = await layer.send(plan, ctx);
  t('首次发送成功', r1.ok === true && s.calls.length === 1);
  const r2 = await layer.send(plan, ctx);
  t('二次被幂等门拦', r2.skipped === true && r2.reason === 'duplicate');
  t('底层只调用一次', s.calls.length === 1);
  t('幂等事件已落库', hasDoneEvent(db, 'p1', 'praise_reply', { key: 'commentId', value: 'c1' }));
}

console.log('\n== 四类 kind 分派 ==');
{
  const s = makeStubs();
  const layer = createSendLayer(s);
  const ctx = { config, state: mkState(), db, usage };
  await layer.send({ kind: 'answer', postId: 'p1', url: 'u', text: '答' }, ctx);
  t('answer → replyOne', s.calls[0].name === 'replyOne');
  await layer.send({ kind: 'praise', postId: 'p1', url: 'u', text: '夸', commentId: 'c2', commentText: '原文', point: '点' }, ctx);
  t('praise → sendPraise 且带 commentText/point', s.calls[1].name === 'sendPraise' && s.calls[1].args.commentText === '原文' && s.calls[1].args.point === '点');
  await layer.send({ kind: 'summon', postId: 'p1', url: 'u', text: '应', commentId: 'c3' }, ctx);
  t('summon → sendSummonReply 且 via 来自 config', s.calls[2].name === 'sendSummonReply' && s.calls[2].args.via === 'api');
  await layer.send({ kind: 'interact', postId: 'p1', url: 'u', text: '接', commentId: 'c4', parentId: 'c2', playerKey: 'k' }, ctx);
  t('interact → sendInteractReply 且带 parentId/playerKey', s.calls[3].name === 'sendInteractReply' && s.calls[3].args.parentId === 'c2' && s.calls[3].args.playerKey === 'k');
  t('unknown kind 回落 replyOne', await (async () => {
    const s2 = makeStubs(); const l2 = createSendLayer(s2);
    await l2.send({ kind: 'whatever', postId: 'p1', url: 'u', text: 'x' }, { config, state: mkState(), db });
    return s2.calls[0].name === 'replyOne';
  })());
}

console.log('\n== 成功后记账 ==');
{
  const s = makeStubs();
  const layer = createSendLayer(s);
  const state = mkState();
  const r = await layer.send(
    { kind: 'answer', postId: 'p1', url: 'u', text: '答案正文', stateFlags: { shareCommented: true }, done: { kind: 'share_reply' }, meta: { qaId: 'q1', scene: 'share_reply' } },
    { config, state, db, usage }
  );
  t('发送成功', r.ok === true);
  t('stateFlags 已合并', state.posts.p1.shareCommented === true);
  t('幂等事件已写', listEvents(db, 'p1').some((e) => e.kind === 'share_reply'));
  t('recentReplies 已记账', Object.keys(state.recentReplies).length === 1);
  t('引用统计已记', usage.items.q1 && usage.items.q1.cited === 1);
}

console.log('\n== 失败透明（计数留给调用方）==');
{
  const s = makeStubs({ ok: false });
  const layer = createSendLayer(s);
  const state = { posts: { p2: {} }, recentReplies: {} }; // 用独立帖，避开上面已写的幂等事件
  const r = await layer.send({ kind: 'answer', postId: 'p2', url: 'u', text: 'x', stateFlags: { shareCommented: true }, done: { kind: 'share_reply' } }, { config, state, db });
  t('返回 ok:false + stage', r.ok === false && r.stage === 'fail_x');
  t('失败不写 stateFlags', !state.posts.p2.shareCommented);
  t('失败不写幂等事件', !listEvents(db, 'p2').some((e) => e.kind === 'share_reply'));
  // 底层抛异常也不崩
  const layer2 = createSendLayer({ replyOne: async () => { throw new Error('boom'); }, sendPraise: async () => ({}), sendSummonReply: async () => ({}), sendInteractReply: async () => ({}) });
  const r2 = await layer2.send({ kind: 'answer', postId: 'p1', url: 'u', text: 'x' }, { config, state: mkState(), db });
  t('异常被捕获', r2.ok === false && r2.stage === 'exception');
}

console.log('\n== trace 落盘 ==');
{
  const s = makeStubs();
  const layer = createSendLayer(s);
  await layer.send({ kind: 'answer', postId: 'p9', url: 'u', text: 'x' }, { config, state: mkState(), db });
  const tf = join(reportsDir, `trace-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const lines = readFileSync(tf, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const sent = lines.filter((l) => l.event === 'sent' && l.postId === 'p9');
  t('写了 sent 事件', sent.length === 1);
  t('sent=true', sent[0].sent === true);
  t('带 kind', sent[0].kind === 'answer');
}
try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);