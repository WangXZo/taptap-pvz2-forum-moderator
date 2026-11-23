// T32 测试（2026-11-20）：内核答疑/婉拒改走统一发送层
//
// 目标：
//   ① 答疑（kind='answer'）与婉拒（kind='refuse'）都经 send-layer 发送 + 记账
//   ② **答疑必须有幂等事件**（以前 core 自己调 replyOne、没写 markDoneEvent → 幂等门查不到）
//   ③ 记账齐全：state 标记 / recentReplies / 引用统计 / trace
//   ④ collect.mjs 里不再有「答疑直接调 replyOne」的路径
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createSendLayer } from './lib/send-layer.mjs';
import { openDb, hasDoneEvent } from './lib/post-records.mjs';

let fail = 0;
function t(name, cond, extra = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { fail++; console.log(`  FAIL ${name}${extra ? `  ${extra}` : ''}`); }
}

const dir = mkdtempSync(join(tmpdir(), 't32-'));
const db = openDb(join(dir, 'rec.sqlite'));

/** 假发送器：记录调用 */
function fakeImpl() {
  const calls = [];
  return {
    calls,
    replyOne: async (a) => { calls.push({ name: 'replyOne', ...a }); return { ok: true, stage: 'api_sent', detail: { commentId: '405999111' } }; },
    sendPraise: async (a) => { calls.push({ name: 'sendPraise', ...a }); return { ok: true }; },
    sendSummonReply: async (a) => { calls.push({ name: 'sendSummonReply', ...a }); return { ok: true }; },
    sendInteractReply: async (a) => { calls.push({ name: 'sendInteractReply', ...a }); return { ok: true }; },
  };
}

console.log('\n== 答疑：走 answer 分支 + 幂等事件 ==');
{
  const impl = fakeImpl();
  const layer = createSendLayer(impl);
  const state = { posts: {}, recentReplies: {} };
  const r = await layer.send(
    {
      kind: 'answer',
      postId: 'P1',
      url: 'https://www.taptap.cn/moment/P1',
      title: '测试帖',
      text: '这是答案正文',
      done: { kind: 'replied', key: 'postId', value: 'P1' },
      stateFlags: { status: 'replied', replied: true },
      meta: { qaId: 'Q1' },
    },
    { config: {}, state, db, usage: null, runner: null, log: () => {} }
  );
  t('发送成功', r.ok === true, JSON.stringify(r));
  t('走的是 replyOne（answer 分支）', impl.calls[0]?.name === 'replyOne', JSON.stringify(impl.calls.map((c) => c.name)));
  t('只调了 1 次（不能重复发）', impl.calls.length === 1, `实际 ${impl.calls.length}`);
  t('幂等事件已写入', hasDoneEvent(db, 'P1', 'replied', { key: 'postId', value: 'P1' }) === true);
  t('state 标记已合并', state.posts.P1?.status === 'replied' && state.posts.P1?.replied === true, JSON.stringify(state.posts.P1));
  t('recentReplies 已记录', Object.keys(state.recentReplies || {}).length === 1, JSON.stringify(state.recentReplies));
}

console.log('\n== 婉拒：走 else 分支（也是一级回复）==');
{
  const impl = fakeImpl();
  const layer = createSendLayer(impl);
  const state = { posts: {}, recentReplies: {} };
  const r = await layer.send(
    {
      kind: 'refuse',
      postId: 'P2',
      url: 'https://www.taptap.cn/moment/P2',
      title: '婉拒帖',
      text: '这块我确实不太确定',
      done: { kind: 'refused', key: 'postId', value: 'P2' },
      stateFlags: { status: 'replied' },
      meta: {},
    },
    { config: {}, state, db, usage: null, runner: null, log: () => {} }
  );
  t('发送成功', r.ok === true);
  t('走 replyOne', impl.calls[0]?.name === 'replyOne');
  t('只调了 1 次', impl.calls.length === 1);
  t('幂等事件已写入（refused）', hasDoneEvent(db, 'P2', 'refused', { key: 'postId', value: 'P2' }) === true);
  t('state 标记已合并', state.posts.P2?.status === 'replied');
}

console.log('\n== sentCommentId 一并落库（T15 衔接）==');
{
  const impl = fakeImpl();
  const layer = createSendLayer(impl);
  const state = { posts: {}, recentReplies: {} };
  await layer.send(
    { kind: 'answer', postId: 'P3', url: 'u', text: '正文', done: { kind: 'replied', key: 'postId', value: 'P3' }, meta: {} },
    { config: {}, state, db, usage: null, runner: null, log: () => {} }
  );
  const { ourSentCommentIds } = await import('./lib/post-records.mjs');
  const ids = ourSentCommentIds(db, 'P3');
  t('我们的评论 id 已落库', ids.has('405999111'), [...ids].join(','));
}

console.log('\n== 失败也要记 trace（不静默） ==');
{
  const layer = createSendLayer({
    replyOne: async () => ({ ok: false, stage: 'send_failed' }),
  });
  const state = { posts: {}, recentReplies: {} };
  const r = await layer.send(
    { kind: 'answer', postId: 'P4', url: 'u', text: '正文', done: { kind: 'replied', key: 'postId', value: 'P4' }, meta: {} },
    { config: {}, state, db, usage: null, runner: null, log: () => {} }
  );
  t('失败返回 ok=false', r.ok === false);
  t('失败不写幂等事件', hasDoneEvent(db, 'P4', 'replied') === false);
  t('失败不合并 state 标记', !state.posts.P4);
}

console.log('\n== collect.mjs 静态检查：所有发送都走 layer.send ==');
{
  const src = readFileSync(new URL('./collect.mjs', import.meta.url), 'utf8');
  const lines = src.split('\n');
  // T33 后：core 不再直接调 replyOne（旧通道块已删），全部经 send-layer
  const calls = [];
  lines.forEach((l, i) => { if (/await replyOne\(/.test(l)) calls.push({ line: i + 1, text: l.trim() }); });
  t('core 不再直接调 replyOne（全部走 send-layer）', calls.length === 0, `实际 ${calls.length} 处：${calls.map((c) => c.line).join(',')}`);
  // 答疑/婉拒/夸码三处用 layer.send
  const sendCount = (src.match(/await layer\.send\(/g) || []).length;
  t('三处（答疑 + 婉拒 + 夸码）', sendCount === 3, `实际 ${sendCount}`);
  // 幂等 kind
  t('答疑幂等 kind=replied', /kind:\s*'replied',\s*key:\s*'postId'/.test(src));
  t('婉拒幂等 kind=refused', /kind:\s*'refused',\s*key:\s*'postId'/.test(src));
  t('夸码幂等 kind=code_praise', /kind:\s*'code_praise',\s*key:\s*'postId'/.test(src));
  // layer 在 runOnce 顶部创建
  t('layer 在 runOnce 顶部创建', /const layer = createSendLayer\(\);/.test(src));
  // T33：旧通道块确实删了
  t('旧 praise 块已删', !/2d\. 社区已有人回答 → 挑出/.test(src));
  t('旧 share 块已删', !/3d\. 分享帖轻互动/.test(src));
  t('旧 comfort 块已删', !/3d-2\. 纯情绪帖/.test(src));
  // 但 code_praise 必须还在（它不在插件里）
  t('code_praise 通道仍在', /kind:\s*'code_praise'/.test(src));
}

db.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 锁 */ }
console.log(fail ? `\n✗ ${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);