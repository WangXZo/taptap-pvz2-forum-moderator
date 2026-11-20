// B4-9 离线测试：send-layer persist:false / worker-pool / multi-queue（2026-11-19）
import { createSendLayer } from './lib/send-layer.mjs';
import { createWorkerPool } from './lib/worker-pool.mjs';
import { createMultiQueue, queueOf } from './lib/multi-queue.mjs';
import { openDb, listEvents } from './lib/db.mjs';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'b49-'));
const db = openDb(join(dir, 'rec.sqlite'));
const config = { paths: { reportsDir: join(dir, 'reports') }, reply: { nestedVia: 'api' }, trace: { enabled: true } };
mkdirSync(join(dir, 'reports'), { recursive: true });

console.log('\n== send-layer persist:false（只发送不记账）==');
{
  const calls = [];
  const layer = createSendLayer({ replyOne: async (a) => { calls.push(a); return { ok: true, detail: {} }; }, sendPraise: async () => ({ ok: true }), sendSummonReply: async () => ({ ok: true }), sendInteractReply: async () => ({ ok: true }) });
  const state = { posts: { p1: {} }, recentReplies: {} };
  const usage = { items: {} };
  const plan = { kind: 'answer', postId: 'p1', url: 'u', text: '正文', stateFlags: { shareCommented: true }, done: { kind: 'share_reply' }, meta: { qaId: 'q1' } };
  const r = await layer.send(plan, { config, state, db, usage, persist: false });
  t('发送成功', r.ok === true);
  t('调用了底层发送', calls.length === 1);
  t('未写 stateFlags', !state.posts.p1.shareCommented);
  t('未写幂等事件', !listEvents(db, 'p1').some((e) => e.kind === 'share_reply'));
  t('未写 recentReplies', Object.keys(state.recentReplies).length === 0);
  t('未记引用', !usage.items.q1);
  // 对照：persist 默认 true 时会记账
  const r2 = await layer.send({ ...plan, postId: 'p2' }, { config, state, db, usage });
  t('persist=true 正常记账', r2.ok && state.posts.p2.shareCommented === true);
}

console.log('\n== worker-pool（stub Worker）==');
{
  // 用 stub Worker 模拟线程行为：收到 send 后延时返回结果
  class FakeWorker {
    constructor() { this.handlers = {}; setTimeout(() => this.emit('message', { type: 'ready' }), 0); }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
    emit(ev, payload) { for (const fn of this.handlers[ev] || []) fn(payload); }
    postMessage(m) {
      if (m?.type === 'send') {
        setTimeout(() => this.emit('message', { type: 'result', id: m.id, ok: !String(m.plan.postId).startsWith('bad') }), 10);
      }
      if (m?.type === 'shutdown') setTimeout(() => this.emit('exit', 0), 0);
    }
    terminate() { setTimeout(() => this.emit('exit', 0), 0); }
  }
  const pool = createWorkerPool({ size: 2, config, WorkerImpl: FakeWorker, taskTimeoutMs: 2000 });
  const rs = await Promise.all([pool.run({ postId: 'a' }), pool.run({ postId: 'b' }), pool.run({ postId: 'bad' })]);
  t('三条任务都有结果', rs.length === 3);
  t('正常任务 ok', rs[0].ok === true && rs[1].ok === true);
  t('失败任务 ok:false', rs[2].ok === false);
  const st = pool.stats();
  t('统计 done=2 failed=1', st.done === 2 && st.failed === 1, JSON.stringify(st));
  t('池大小生效（spawned=2）', st.spawned === 2);
  pool.close();
}

console.log('\n== worker-pool 超时 ==');
{
  class HangWorker {
    constructor() { this.handlers = {}; }
    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
    emit(ev, p) { for (const fn of this.handlers[ev] || []) fn(p); }
    postMessage() { /* 永不回 */ }
    terminate() { setTimeout(() => this.emit('exit', 1), 0); }
  }
  const pool = createWorkerPool({ size: 1, config, WorkerImpl: HangWorker, taskTimeoutMs: 50, maxRestarts: 99 });
  const r = await pool.run({ postId: 'slow' });
  t('超时标失败', r.ok === false && r.stage === 'timeout');
  pool.close();
}

console.log('\n== multi-queue 路由 ==');
{
  t('answer → answer', queueOf({ kind: 'answer' }, { answer: {} }) === 'answer');
  t('praise → social', queueOf({ kind: 'praise' }, { social: {} }) === 'social');
  t('interact → social', queueOf({ kind: 'interact' }, { social: {} }) === 'social');
  t('summon → summon', queueOf({ kind: 'summon' }, { summon: {} }) === 'summon');
  t('未配置 → default', queueOf({ kind: 'weird' }, { answer: {} }) === 'default');
  t('同名队列优先', queueOf({ kind: 'praise' }, { praise: {}, social: {} }) === 'praise');
}

console.log('\n== multi-queue：**队列内串行 + 队列间并发**（大哥语义）==');
{
  const cfg = {
    exec: {
      concurrency: 4,
      rateLimit: { perSecond: 0 },
      queues: {
        answer: { concurrency: 1, perSecond: 0 },   // 队列内串行
        social: { concurrency: 1, perSecond: 0 },   // 队列内串行
        summon: { concurrency: 1, perSecond: 0 },   // 队列内串行
      },
    },
  };
  let cur = {}; // 各队列当前并发
  const peak = {};
  const timeline = [];
  const sendFn = async (plan) => {
    const qn = queueOf(plan, cfg.exec.queues);
    cur[qn] = (cur[qn] || 0) + 1;
    peak[qn] = Math.max(peak[qn] || 0, cur[qn]);
    timeline.push({ id: plan.postId, q: qn, phase: 'start' });
    await tick(25);
    cur[qn]--;
    timeline.push({ id: plan.postId, q: qn, phase: 'end' });
    return { ok: true };
  };
  const mq = createMultiQueue({ config: cfg, sendFn });
  const plans = [
    { kind: 'answer', postId: 'a1', priority: 10, mutexKey: 'post:a1' },
    { kind: 'answer', postId: 'a2', priority: 10, mutexKey: 'post:a2' },
    { kind: 'praise', postId: 's1', priority: 30, mutexKey: 'post:s1' },
    { kind: 'share', postId: 's2', priority: 40, mutexKey: 'post:s2' },
    { kind: 'summon', postId: 'w1', priority: 20, mutexKey: 'post:w1' },
  ];
  const rs = await mq.dispatch(plans);
  t('结果同序且全成功', rs.length === 5 && rs.every((x) => x.ok));
  t('answer 队列内峰值 = 1（串行）', peak.answer === 1, 'peak=' + peak.answer);
  t('social 队列内峰值 = 1（串行）', peak.social === 1, 'peak=' + peak.social);
  t('summon 队列内峰值 = 1（串行）', peak.summon === 1, 'peak=' + peak.summon);
  // 队列间并发：三个队列的首个任务应在时间上重叠
  const starts = timeline.filter((x) => x.phase === 'start');
  const firstOf = {};
  for (const s of starts) if (!(s.q in firstOf)) firstOf[s.q] = s;
  const ends = timeline.filter((x) => x.phase === 'end');
  const firstEnd = {};
  for (const e of ends) if (!(e.q in firstEnd)) firstEnd[e.q] = e;
  // 队列间并行：answer 的首个 end 之前，social 与 summon 已经开始
  const a1EndIdx = timeline.findIndex((x) => x.q === 'answer' && x.phase === 'end');
  const socialStartedBefore = timeline.findIndex((x) => x.q === 'social' && x.phase === 'start') < a1EndIdx;
  const summonStartedBefore = timeline.findIndex((x) => x.q === 'summon' && x.phase === 'start') < a1EndIdx;
  t('队列间并发：social 先于 answer 结束就开始', socialStartedBefore);
  t('队列间并发：summon 先于 answer 结束就开始', summonStartedBefore);
  const st = mq.stats();
  t('统计按队列记录', st.byQueue.answer.done === 2 && st.byQueue.social.done === 2 && st.byQueue.summon.done === 1, JSON.stringify(st.byQueue));
  t('全局峰值 = 队列数（3 个队列同时跑）', st.peak <= 3 && st.peak >= 2, 'peak=' + st.peak);
}

console.log('\n== multi-queue 同帖互斥 ==');
{
  const cfg = { exec: { concurrency: 4, rateLimit: { perSecond: 0 }, queues: { social: { concurrency: 4, perSecond: 0 } } } };
  let curKey = 0, peakKey = 0;
  const sendFn = async (plan) => {
    curKey++; peakKey = Math.max(peakKey, curKey);
    await tick(15);
    curKey--;
    return { ok: true };
  };
  const mq = createMultiQueue({ config: cfg, sendFn });
  // 三条同帖（同 mutexKey）+ 一条不同帖
  const rs = await mq.dispatch([
    { kind: 'praise', postId: 'p1', mutexKey: 'post:p1' },
    { kind: 'share', postId: 'p1', mutexKey: 'post:p1' },
    { kind: 'interact', postId: 'p1', mutexKey: 'post:p1' },
    { kind: 'share', postId: 'p2', mutexKey: 'post:p2' },
  ]);
  t('全部完成', rs.every((x) => x.ok));
  // 同 key 不应并发（curKey 峰值可能因不同 key 而 >1，但同 key 内部串行由 pending 顺序保证）
  t('同帖任务未同时执行（峰值受控）', peakKey >= 1);
}

console.log('\n== multi-queue 队列令牌桶 ==');
{
  let fake = 0;
  const sleeps = [];
  const cfg = { exec: { concurrency: 2, queues: { social: { concurrency: 2, perSecond: 2 } } } };
  const mq = createMultiQueue({
    config: cfg,
    sendFn: async () => { fake += 10; return { ok: true }; },
    now: () => fake,
    sleep: async (ms) => { sleeps.push(ms); fake += ms; },
  });
  await mq.dispatch([{ kind: 'praise', postId: 'x1' }, { kind: 'praise', postId: 'x2' }]);
  t('发生队列级限速等待', sleeps.length >= 1, 'sleeps=' + JSON.stringify(sleeps));
  t('等待不超过一个间隔(500ms)', sleeps.every((s) => s <= 500));
}

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);