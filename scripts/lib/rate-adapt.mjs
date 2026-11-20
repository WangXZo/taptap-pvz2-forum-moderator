// 自适应限速（2026-11-20 · T21）
//
// 大哥 2026-11-20 口径：
//   「我没有要求过具体的，限制速率等发送要求，只是会 WAF，你自行避让的，不应作为要求。」
//
// 所以限速**不是产品需求**，是工程保险。之前把它写成硬要求（perSecond=0.17 ≈ 6 秒/条），
// 四处叠加后吞吐被压到 ~10 条/分钟，直接导致「回复不及时」。
//
// 现在的策略（AIMD，和 TCP 拥塞控制同思路）：
//
//   默认全速（perSecond = 0，不等待）
//       ↓ 每次发送后记录结果
//   检出 WAF → 立刻降速 ×0.5（不低于 floor）+ 冷却 cooldownMs
//       ↓ 冷却结束
//   每成功 recoverEvery 次 → 提速 ×recoverFactor
//       ↓ 提到 ≥1 就视为恢复，回到全速
//   连续 hardBrakeAfter 次 WAF → 硬刹车 pauseMinutes（暂停所有发送，只保留读）
//
// 三种模式（exec.rateLimit.mode）：
//   off      —— 完全不限速
//   fixed    —— 用 exec.rateLimit.perSecond（旧行为，随时可切回）
//   adaptive —— 上面这套（默认）

/**
 * @param {object} o
 * @param {object} [o.config]
 * @param {Function} [o.now]  注入时钟（测试）
 * @param {Function} [o.log]
 */
export function createAdaptiveRate({ config = {}, now = () => Date.now(), log = () => {} } = {}) {
  const c = config.exec?.rateLimit || {};
  const w = c.waf || {};
  const mode = String(c.mode || 'adaptive');

  const CFG = {
    mode,
    cooldownMs: Number(w.cooldownMs ?? 60000),
    recoverEvery: Math.max(1, Number(w.recoverEvery ?? 20)),
    recoverFactor: Math.max(1.01, Number(w.recoverFactor ?? 1.5)),
    hardBrakeAfter: Math.max(1, Number(w.hardBrakeAfter ?? 3)),
    pauseMinutes: Math.max(1, Number(w.pauseMinutes ?? 15)),
    floor: Math.max(0.01, Number(w.floorPerSecond ?? 0.1)),
    fixed: Math.max(0, Number(c.perSecond ?? 0)),
  };

  // 当前每秒配额；0 = 不限
  let perSecond = mode === 'fixed' ? CFG.fixed : 0;
  let cooldownUntil = 0;
  let pauseUntil = 0;
  let successStreak = 0;
  let failStreak = 0;
  let lastStart = 0;
  let totalWaf = 0;
  let totalSuccess = 0;

  /** 还需要等多久才能派发下一个 */
  function waitMs() {
    if (CFG.mode === 'off') return 0;
    const n = now();
    if (pauseUntil > n) return pauseUntil - n;
    if (cooldownUntil > n) return cooldownUntil - n;
    if (perSecond > 0) {
      const gap = Math.ceil(1000 / perSecond);
      const left = lastStart + gap - n;
      return left > 0 ? left : 0;
    }
    return 0;
  }

  /** 记录「现在开始发了」，用于计算最小间隔 */
  function markStart() {
    lastStart = now();
  }

  /** 成功一次 */
  function onSuccess() {
    totalSuccess++;
    failStreak = 0;
    if (perSecond <= 0) return { changed: false, perSecond };
    successStreak++;
    if (successStreak < CFG.recoverEvery) return { changed: false, perSecond, streak: successStreak };
    successStreak = 0;
    const next = perSecond * CFG.recoverFactor;
    const before = perSecond;
    // 提到 ≥1 视为已恢复 → 回到全速
    perSecond = next >= 1 ? 0 : next;
    log(
      `    [限速] 恢复试探：${before.toFixed(2)}/s → ${perSecond > 0 ? `${perSecond.toFixed(2)}/s` : '全速（不限）'}`
    );
    return { changed: true, from: before, perSecond };
  }

  /**
   * 检出 WAF 一次
   * @param {string} [reason]
   */
  function onWaf(reason = '') {
    totalWaf++;
    failStreak++;
    successStreak = 0;
    // 从「不限」开始降时，先给一个基准再折半，否则 0*0.5 还是 0
    const base = perSecond > 0 ? perSecond : 1;
    const before = perSecond;
    perSecond = Math.max(CFG.floor, base * 0.5);
    cooldownUntil = now() + CFG.cooldownMs;
    const out = { before, perSecond, cooldownMs: CFG.cooldownMs, failStreak, paused: false };
    if (failStreak >= CFG.hardBrakeAfter) {
      pauseUntil = now() + CFG.pauseMinutes * 60000;
      out.paused = true;
      out.pauseMinutes = CFG.pauseMinutes;
      log(
        `    [限速] ⚠ 连续 ${failStreak} 次被 WAF 拦（${reason || 'unknown'}）→ 硬刹车 ${CFG.pauseMinutes} 分钟，只保留读`
      );
    } else {
      log(
        `    [限速] WAF（${reason || 'unknown'}）：${before > 0 ? `${before.toFixed(2)}` : '全速'} → ${perSecond.toFixed(2)}/s，冷却 ${Math.round(CFG.cooldownMs / 1000)}s`
      );
    }
    return out;
  }

  /** 手动恢复全速（运维用） */
  function reset() {
    perSecond = CFG.mode === 'fixed' ? CFG.fixed : 0;
    cooldownUntil = 0;
    pauseUntil = 0;
    successStreak = 0;
    failStreak = 0;
  }

  function state() {
    const n = now();
    return {
      mode: CFG.mode,
      perSecond,
      effectivePerSecond: perSecond > 0 ? perSecond : null, // null = 不限
      minGapMs: perSecond > 0 ? Math.ceil(1000 / perSecond) : 0,
      cooling: cooldownUntil > n,
      cooldownLeftMs: Math.max(0, cooldownUntil - n),
      paused: pauseUntil > n,
      pauseLeftMs: Math.max(0, pauseUntil - n),
      successStreak,
      failStreak,
      totalWaf,
      totalSuccess,
    };
  }

  return { waitMs, markStart, onSuccess, onWaf, reset, state, cfg: CFG };
}