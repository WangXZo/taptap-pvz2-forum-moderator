// 自适应限速测试（2026-11-20 · T21）
import { createAdaptiveRate } from './lib/rate-adapt.mjs';
import { createQueue } from './lib/exec-queue.mjs';

let fail = 0;
function t(name, cond, extra = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { fail++; console.log(`  FAIL ${name}${extra ? `  ${extra}` : ''}`); }
}

/** 可推进的假时钟 */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; }, set: (v) => { t = v; } };
}

const baseCfg = {
  exec: {
    rateLimit: {
      mode: 'adaptive',
      perSecond: 0,
      waf: { cooldownMs: 60000, recoverEvery: 3, recoverFactor: 2, hardBrakeAfter: 3, pauseMinutes: 15, floorPerSecond: 0.1 },
    },
  },
};

console.log('\n== 默认全速 ==');
{
  const ck = fakeClock();
  const r = createAdaptiveRate({ config: baseCfg, now: ck.now, log: () => {} });
  t('初始 perSecond=0（不限）', r.state().perSecond === 0);
  t('waitMs = 0', r.waitMs() === 0);
  t('minGapMs = 0', r.state().minGapMs === 0);
  t('effectivePerSecond = null', r.state().effectivePerSecond === null);
}

console.log('\n== mode=off 完全不管 ==');
{
  const ck = fakeClock();
  const r = createAdaptiveRate({ config: { exec: { rateLimit: { mode: 'off' } } }, now: ck.now });
  r.onWaf('x');
  t('off 模式下 WAF 后 waitMs 仍 0', r.waitMs() === 0);
}

console.log('\n== mode=fixed 保持旧行为 ==');
{
  const ck = fakeClock();
  const r = createAdaptiveRate({ config: { exec: { rateLimit: { mode: 'fixed', perSecond: 0.5 } } }, now: ck.now });
  t('初始 0.5/s', r.state().perSecond === 0.5);
  t('minGapMs = 2000', r.state().minGapMs === 2000);
  r.markStart();
  t('刚发过 → 要等 2 秒', r.waitMs() === 2000, String(r.waitMs()));
  ck.tick(2000);
  t('等满 → 不用等', r.waitMs() === 0);
  r.onSuccess();
  t('fixed 模式不自己恢复', r.state().perSecond === 0.5);
}

console.log('\n== WAF 降速 ==');
{
  const ck = fakeClock();
  const logs = [];
  const r = createAdaptiveRate({ config: baseCfg, now: ck.now, log: (m) => logs.push(m) });
  const out = r.onWaf('WAF_BLOCKED');
  t('从全速降到 0.5/s', r.state().perSecond === 0.5, String(r.state().perSecond));
  t('返回 cooldownMs', out.cooldownMs === 60000);
  t('进入冷却', r.state().cooling === true);
  t('waitMs 反映冷却剩余', r.waitMs() === 60000, String(r.waitMs()));
  t('打了日志', logs.some((l) => l.includes('WAF')), JSON.stringify(logs));
  ck.tick(60000);
  t('冷却结束不再 cooling', r.state().cooling === false);
  t('冷却后仍降速（0.5/s）', r.state().perSecond === 0.5);
}

console.log('\n== 成功恢复试探 ==');
{
  const ck = fakeClock();
  const r = createAdaptiveRate({ config: baseCfg, now: ck.now, log: () => {} });
  r.onWaf('x');                        // → 0.5
  t('降速后 0.5', r.state().perSecond === 0.5);
  r.onSuccess();
  r.onSuccess();
  t('成功 2 次还没变（recoverEvery=3）', r.state().perSecond === 0.5);
  r.onSuccess();                       // 第 3 次 → ×2 = 1.0 → 视为恢复 → 0
  t('成功 3 次回到全速', r.state().perSecond === 0, String(r.state().perSecond));
}

console.log('\n== 硬刹车 ==');
{
  const ck = fakeClock();
  const logs = [];
  const r = createAdaptiveRate({ config: baseCfg, now: ck.now, log: (m) => logs.push(m) });
  r.onWaf('1');       // failStreak=1
  r.onWaf('2');       // 2
  t('两次还没刹车', r.state().paused === false);
  const out = r.onWaf('3');   // 3 → 刹车
  t('第三次触发刹车', out.paused === true);
  t('paused = true', r.state().paused === true);
  t('暂停 15 分钟', r.state().pauseLeftMs === 15 * 60000, String(r.state().pauseLeftMs));
  t('日志提示硬刹车', logs.some((l) => l.includes('硬刹车')), JSON.stringify(logs));
  ck.tick(15 * 60000);
  t('暂停结束后解除', r.state().paused === false);
}
{
  // 中间成功会重置连续失败计数
  const ck = fakeClock();
  const r = createAdaptiveRate({ config: baseCfg, now: ck.now, log: () => {} });
  r.onWaf('1'); r.onWaf('2');
  r.onSuccess();                 // failStreak 归零
  const out = r.onWaf('3');
  t('成功后重置失败计数，不刹车', out.paused === false, JSON.stringify(out));
}

console.log('\n== floor 保护 ==');
{
  const ck = fakeClock();
  const r = createAdaptiveRate({ config: baseCfg, now: ck.now, log: () => {} });
  for (let i = 0; i < 10; i++) r.onWaf('x');
  t('不会降到 floor 以下（0.1）', r.state().perSecond >= 0.1, String(r.state().perSecond));
}

console.log('\n== reset ==');
{
  const ck = fakeClock();
  const r = createAdaptiveRate({ config: baseCfg, now: ck.now, log: () => {} });
  r.onWaf('x');
  r.reset();
  t('reset 回到全速', r.state().perSecond === 0);
  t('reset 清冷却', r.state().cooling === false);
  t('reset 清暂停', r.state().paused === false);
}

console.log('\n== 与 exec-queue 集成 ==');
{
  const ck = fakeClock();
  const r = createAdaptiveRate({ config: baseCfg, now: ck.now, log: () => {} });
  const slept = [];
  const q = createQueue({
    concurrency: 1,
    rate: r,
    now: ck.now,
    sleep: async (ms) => { slept.push(ms); },
  });
  const res = await q.dispatch(
    [{ priority: 1 }, { priority: 2 }],
    async () => ({ ok: true })
  );
  t('两个任务都成功', res.every((x) => x.ok));
  t('全速模式下没等待', slept.length === 0, JSON.stringify(slept));
  t('统计 started=2', q.stats().started === 2);
}
{
  // executor 返回 waf → 限速器降速
  const ck = fakeClock();
  const r = createAdaptiveRate({ config: baseCfg, now: ck.now, log: () => {} });
  const q = createQueue({ concurrency: 1, rate: r, now: ck.now, sleep: async () => {} });
  await q.dispatch([{}], async () => ({ ok: false, waf: true, error: 'WAF_BLOCKED' }));
  t('queue 把 waf 传给限速器', r.state().totalWaf === 1, String(r.state().totalWaf));
  t('限速器已降速', r.state().perSecond === 0.5);
  t('stats.waf = 1', q.stats().waf === 1);
}
{
  // 下一次派发应该等冷却
  const ck = fakeClock();
  const r = createAdaptiveRate({ config: baseCfg, now: ck.now, log: () => {} });
  r.onWaf('x');
  const slept = [];
  const q = createQueue({ concurrency: 1, rate: r, now: ck.now, sleep: async (ms) => { slept.push(ms); } });
  await q.dispatch([{}], async () => ({ ok: true }));
  t('冷却期内派发会等待', slept.length === 1 && slept[0] === 60000, JSON.stringify(slept));
  t('统计 waitedMs', q.stats().waitedMs === 60000, String(q.stats().waitedMs));
}

console.log(fail ? `\n✗ ${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);