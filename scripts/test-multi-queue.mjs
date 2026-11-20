// 多队列测试（2026-10-25 · T22 perPlugin/perPost 模式）
import { queueOf, createMultiQueue } from './lib/multi-queue.mjs';
import { createAdaptiveRate } from './lib/rate-adapt.mjs';

let fail = 0;
function t(name, cond, extra = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { fail++; console.log(`  FAIL ${name}${extra ? `  ${extra}` : ''}`); }
}

const fixedQueues = { answer: { concurrency: 1 }, social: { concurrency: 1 }, summon: { concurrency: 1 } };

console.log('\n== queueOf: fixed（旧行为）==');
t('answer → answer', queueOf({ kind: 'answer' }, fixedQueues) === 'answer');
t('praise → social', queueOf({ kind: 'praise' }, fixedQueues) === 'social');
t('share → social', queueOf({ kind: 'share' }, fixedQueues) === 'social');
t('comfort → social', queueOf({ kind: 'comfort' }, fixedQueues) === 'social');
t('interact → social', queueOf({ kind: 'interact' }, fixedQueues) === 'social');
t('summon → summon', queueOf({ kind: 'summon' }, fixedQueues) === 'summon');
t('未配置的 kind → default', queueOf({ kind: 'weird' }, fixedQueues) === 'default');

console.log('\n== queueOf: perPlugin ==');
{
  const opt = { mode: 'perPlugin' };
  t('answer 单独一条', queueOf({ kind: 'answer' }, fixedQueues, opt) === 'answer');
  t('praise 单独一条（不再并进 social）', queueOf({ kind: 'praise' }, fixedQueues, opt) === 'praise');
  t('share 单独一条', queueOf({ kind: 'share' }, fixedQueues, opt) === 'share');
  t('comfort 单独一条', queueOf({ kind: 'comfort' }, fixedQueues, opt) === 'comfort');
  t('interact 单独一条', queueOf({ kind: 'interact' }, fixedQueues, opt) === 'interact');
  t('summon 单独一条', queueOf({ kind: 'summon' }, fixedQueues, opt) === 'summon');
  // 插件名优先于 kind：interact 插件的认错走 kind=summon，但应归 interact 队列
  t('plugin 字段优先于 kind', queueOf({ kind: 'summon', plugin: 'interact' }, fixedQueues, opt) === 'interact');
}

console.log('\n== queueOf: perPost ==');
{
  const opt = { mode: 'perPost' };
  t('按 postId 分队列', queueOf({ kind: 'answer', postId: '111' }, fixedQueues, opt) === 'post:111');
  t('不同帖不同队列', queueOf({ kind: 'answer', postId: '222' }, fixedQueues, opt) === 'post:222');
  t('无 postId → default', queueOf({ kind: 'answer' }, fixedQueues, opt) === 'default');
}

console.log('\n== 队列间并发（perPlugin 核心价值）==');
{
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const config = {
    exec: {
      concurrency: 1,
      queues: { mode: 'perPlugin', answer: { concurrency: 1 }, praise: { concurrency: 1 } },
      rateLimit: { mode: 'off' },
    },
  };
  const order = [];
  const mq = createMultiQueue({
    config,
    sendFn: async (plan) => {
      order.push(['start', plan.kind]);
      await sleepMs(60);
      order.push(['end', plan.kind]);
      return { ok: true };
    },
  });
  const t0 = Date.now();
  await mq.dispatch([
    { kind: 'answer', plugin: 'answer', postId: 'p1' },
    { kind: 'praise', plugin: 'praise', postId: 'p2' },
  ]);
  const ms = Date.now() - t0;
  t('两个任务并行（<110ms，串行会 >120ms）', ms < 110, `实际 ${ms}ms`);
  // 两个都应该在对方结束前开始
  const firstEnd = order.findIndex((x) => x[0] === 'end');
  const startsBeforeFirstEnd = order.slice(0, firstEnd).filter((x) => x[0] === 'start').length;
  t('第一个结束前两个都已开始', startsBeforeFirstEnd === 2, JSON.stringify(order));
  t('stats.peak = 2', mq.stats().peak === 2, String(mq.stats().peak));
  t('两条队列各自记数', mq.stats().byQueue.answer.done === 1 && mq.stats().byQueue.praise.done === 1);
}

console.log('\n== 队列内串行 ==');
{
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const config = {
    exec: { concurrency: 1, queues: { mode: 'perPlugin', answer: { concurrency: 1 } }, rateLimit: { mode: 'off' } },
  };
  let maxConcurrent = 0;
  let cur = 0;
  const mq = createMultiQueue({
    config,
    sendFn: async () => {
      cur++;
      maxConcurrent = Math.max(maxConcurrent, cur);
      await sleepMs(30);
      cur--;
      return { ok: true };
    },
  });
  await mq.dispatch([
    { kind: 'answer', plugin: 'answer', postId: 'p1' },
    { kind: 'answer', plugin: 'answer', postId: 'p2' },
    { kind: 'answer', plugin: 'answer', postId: 'p3' },
  ]);
  t('同队列内严格串行（峰值 1）', maxConcurrent === 1, String(maxConcurrent));
}

console.log('\n== 同帖 mutex 串行（跨队列也生效）==');
{
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const config = {
    exec: { concurrency: 4, queues: { mode: 'perPlugin' }, rateLimit: { mode: 'off' } },
  };
  let maxSamePost = 0;
  const perPost = {};
  const mq = createMultiQueue({
    config,
    sendFn: async (plan) => {
      const k = plan.mutexKey;
      perPost[k] = (perPost[k] || 0) + 1;
      maxSamePost = Math.max(maxSamePost, perPost[k]);
      await sleepMs(30);
      perPost[k]--;
      return { ok: true };
    },
  });
  await mq.dispatch([
    { kind: 'answer', plugin: 'answer', postId: 'p1', mutexKey: 'post:p1' },
    { kind: 'praise', plugin: 'praise', postId: 'p1', mutexKey: 'post:p1' },
    { kind: 'comfort', plugin: 'comfort', postId: 'p2', mutexKey: 'post:p2' },
  ]);
  t('同帖不并发（峰值 1）', maxSamePost === 1, String(maxSamePost));
}

console.log('\n== maxQueues 上限降级 ==');
{
  const config = {
    exec: { concurrency: 4, maxQueues: 3, queues: { mode: 'perPost' }, rateLimit: { mode: 'off' } },
  };
  const mq = createMultiQueue({ config, sendFn: async () => ({ ok: true }) });
  await mq.dispatch([
    { kind: 'answer', postId: 'p1' },
    { kind: 'answer', postId: 'p2' },
    { kind: 'answer', postId: 'p3' },
    { kind: 'answer', postId: 'p4' },
    { kind: 'answer', postId: 'p5' },
  ]);
  const s = mq.stats();
  t('队列数被 maxQueues 限制', s.queueCount <= 3, `实际 ${s.queueCount}`);
  t('全部任务仍然完成', s.done === 5, JSON.stringify(s.byQueue));
}

console.log('\n== 自适应限速器注入 ==');
{
  const config = {
    exec: {
      concurrency: 1,
      queues: { mode: 'perPlugin' },
      rateLimit: { mode: 'adaptive', waf: { cooldownMs: 1000, hardBrakeAfter: 3, pauseMinutes: 1 } },
    },
  };
  let fakeNow = 1_000_000;
  const rate = createAdaptiveRate({ config, now: () => fakeNow, log: () => {} });
  const slept = [];
  const mq = createMultiQueue({
    config,
    rate,
    now: () => fakeNow,
    sleep: async (ms) => { slept.push(ms); fakeNow += ms; },
    sendFn: async () => ({ ok: true }),
  });
  await mq.dispatch([{ kind: 'answer', plugin: 'answer', postId: 'p1' }]);
  t('全速时无等待', slept.length === 0, JSON.stringify(slept));

  // 触发一次 WAF，下一次应等待冷却
  const mq2 = createMultiQueue({
    config,
    rate,
    now: () => fakeNow,
    sleep: async (ms) => { slept.push(ms); fakeNow += ms; },
    sendFn: async () => ({ ok: false, waf: true, error: 'WAF_BLOCKED' }),
  });
  await mq2.dispatch([{ kind: 'answer', plugin: 'answer', postId: 'p2' }]);
  t('WAF 被记入 stats', mq2.stats().waf === 1, JSON.stringify(mq2.stats()));
  t('限速器已降速', rate.state().perSecond > 0, JSON.stringify(rate.state()));
}

console.log('\n== mode=off 时不限速 ==');
{
  const config = { exec: { concurrency: 1, queues: { mode: 'fixed' }, rateLimit: { mode: 'off' } } };
  const slept = [];
  const mq = createMultiQueue({
    config,
    sleep: async (ms) => slept.push(ms),
    sendFn: async () => ({ ok: true }),
  });
  const t0 = Date.now();
  await mq.dispatch([
    { kind: 'answer', postId: 'p1' },
    { kind: 'answer', postId: 'p2' },
    { kind: 'answer', postId: 'p3' },
  ]);
  t('off 模式无 sleep 等待', slept.length === 0, JSON.stringify(slept));
  t('总耗时很短（<50ms）', Date.now() - t0 < 50, String(Date.now() - t0));
}

console.log(fail ? `\n✗ ${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);