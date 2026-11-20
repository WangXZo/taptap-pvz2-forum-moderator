// B4-1 exec-queue 离线测试（2026-11-19）：并发 1/2/3、互斥键、优先级、限速、失败隔离。
import { createQueue } from './lib/exec-queue.mjs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** 造一个能记录"同时进行数"的执行器 */
function makeExecutor({ ms = 10, failOn = [] } = {}) {
  let cur = 0;
  const trace = [];
  const exec = async (plan) => {
    cur++;
    trace.push({ id: plan.id, phase: 'start', cur });
    await tick(ms);
    cur--;
    trace.push({ id: plan.id, phase: 'end', cur });
    if (failOn.includes(plan.id)) return { ok: false, error: 'boom' };
    return { ok: true, id: plan.id };
  };
  return { exec, trace, peak: () => Math.max(...trace.map((x) => x.cur), 0) };
}

const mk = (id, { priority = 100, mutexKey = null } = {}) => ({ id, priority, mutexKey });

console.log('\n== 并发 1（严格串行）==');
{
  const { exec, peak } = makeExecutor({ ms: 8 });
  const q = createQueue({ concurrency: 1 });
  const r = await q.dispatch([mk('a'), mk('b'), mk('c')], exec);
  t('三个都成功', r.every((x) => x.ok));
  t('峰值 1', peak() === 1);
  t('stats.started=3', q.stats().started === 3);
  t('stats.done=3', q.stats().done === 3);
}

console.log('\n== 并发 2 ==');
{
  const { exec, peak } = makeExecutor({ ms: 12 });
  const q = createQueue({ concurrency: 2 });
  const r = await q.dispatch([mk('a'), mk('b'), mk('c'), mk('d')], exec);
  t('四个都成功', r.every((x) => x.ok));
  t('峰值 ≤2 且 >1', peak() <= 2 && peak() > 1, 'peak=' + peak());
  t('峰值恰为 2（4 个任务够填满）', peak() === 2);
}

console.log('\n== 并发 3 ==');
{
  const { exec, peak } = makeExecutor({ ms: 12 });
  const q = createQueue({ concurrency: 3 });
  const r = await q.dispatch([mk('a'), mk('b'), mk('c'), mk('d'), mk('e')], exec);
  t('五个都成功', r.every((x) => x.ok));
  t('峰值恰为 3', peak() === 3, 'peak=' + peak());
}

console.log('\n== 互斥键（同帖不并发）==');
{
  const { exec, peak, trace } = makeExecutor({ ms: 15 });
  const q = createQueue({ concurrency: 3 });
  // 3 个任务同 mutexKey=post:1 + 1 个不同 key
  const plans = [mk('a', { mutexKey: 'post:1' }), mk('b', { mutexKey: 'post:1' }), mk('c', { mutexKey: 'post:1' }), mk('d', { mutexKey: 'post:2' })];
  const r = await q.dispatch(plans, exec);
  t('全部成功', r.every((x) => x.ok));
  // 同 key 的 a/b/c 必须严格串行：任意时刻同 key 至多 1 个
  let curA = 0, peakA = 0;
  for (const x of trace) {
    if (x.id === 'd') continue;
    curA += x.phase === 'start' ? 1 : -1;
    peakA = Math.max(peakA, curA);
  }
  t('同 key 峰值 1', peakA === 1, 'peakA=' + peakA);
  t('不同 key 可并发（总峰 >1）', peak() > 1, 'peak=' + peak());
}

console.log('\n== 优先级排序 ==');
{
  const order = [];
  const q = createQueue({ concurrency: 1 });
  await q.dispatch(
    [mk('low', { priority: 90 }), mk('high', { priority: 10 }), mk('mid', { priority: 50 })],
    async (plan) => { order.push(plan.id); return { ok: true }; }
  );
  t('按 priority 升序执行', JSON.stringify(order) === JSON.stringify(['high', 'mid', 'low']), JSON.stringify(order));
}

console.log('\n== 结果与入参同序 ==');
{
  const q = createQueue({ concurrency: 1 });
  const plans = [mk('x', { priority: 90 }), mk('y', { priority: 10 })];
  const r = await q.dispatch(plans, async (p) => ({ ok: true, id: p.id }));
  t('结果按入参顺序返回', r[0].id === 'x' && r[1].id === 'y');
}

console.log('\n== 失败隔离 ==');
{
  const { exec } = makeExecutor({ ms: 5, failOn: ['b'] });
  const q = createQueue({ concurrency: 2 });
  const r = await q.dispatch([mk('a'), mk('b'), mk('c')], exec);
  t('失败任务标 ok:false', r.find((x) => x?.id === 'b' || x?.ok === false)?.ok === false);
  t('其他任务不受影响', r.filter((x) => x.ok).length === 2);
  t('stats.failed=1', q.stats().failed === 1);
  // 执行器抛异常也不崩
  const q2 = createQueue({ concurrency: 1 });
  const r2 = await q2.dispatch([mk('z')], async () => { throw new Error('explode'); });
  t('抛异常被捕获', r2[0].ok === false && r2[0].error.includes('explode'));
}

console.log('\n== 空批次 ==');
{
  const q = createQueue();
  const r = await q.dispatch([], async () => ({ ok: true }));
  t('空数组返回空', Array.isArray(r) && r.length === 0);
  t('stats 全 0', q.stats().started === 0);
}

console.log('\n== 令牌桶限速 ==');
{
  // perSecond=2 → minGap=500ms；用注入时钟验证"启动间隔"逻辑被调用
  let fakeNow = 0;
  const sleeps = [];
  const q = createQueue({
    concurrency: 2,
    rateLimit: { perSecond: 2 },
    now: () => fakeNow,
    sleep: async (ms) => { sleeps.push(ms); fakeNow += ms; },
  });
  t('minGap 计算正确（1000/2=500）', q.minGapMs === 500, 'minGap=' + q.minGapMs);
  await q.dispatch([mk('a'), mk('b')], async () => { fakeNow += 10; return { ok: true }; });
  t('发生了限速等待', sleeps.length >= 1, 'sleeps=' + JSON.stringify(sleeps));
  t('等待时长不超过一个间隔', sleeps.every((s) => s <= 500));
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);