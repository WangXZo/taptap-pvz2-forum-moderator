// 执行队列（B4-1，2026-11-19）：优先级 + 并发上限 + 互斥键 + 令牌桶限速。
//
// 大哥 2026-11-19 决策：
//   · **串行只是当前过渡**（concurrency=1），目标态多队列并行；并发度必须是可配旋钮，禁止硬编码串行。
//   · 互斥键（mutexKey）保证「同一帖不并发」，即使 concurrency>1。
//   · 限速用令牌桶（perSecond），替代粗粒度 delayMs。
//   · 单个任务失败不阻塞后续；结果/耗时/并发峰值可观测。

/**
 * @param {object} o
 * @param {number} [o.concurrency=1] 并发上限（1=严格串行；>1 时按互斥键避让）
 * @param {object} [o.rateLimit] {perSecond} 每秒最多启动几个（0/未给=不限）
 * @param {object} [o.rate] 自适应限速器（lib/rate-adapt.mjs）。给了就**优先用它**，
 *   它负责 waitMs/markStart/onSuccess/onWaf；此时忽略 rateLimit。
 * @param {Function} [o.log]
 * @param {Function} [o.now]   注入时钟（测试）
 * @param {Function} [o.sleep] 注入 sleep（测试）
 */
export function createQueue({ concurrency = 1, rateLimit = null, rate = null, log = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const limit = Math.max(1, Number(concurrency) || 1);
  const perSecond = rateLimit && Number(rateLimit.perSecond) > 0 ? Number(rateLimit.perSecond) : 0;
  const minGapMs = perSecond ? Math.ceil(1000 / perSecond) : 0;
  const limiter = rate || null;
  const stats = { done: 0, failed: 0, started: 0, peak: 0, waf: 0, waitedMs: 0 };
  let lastStart = 0;

  /**
   * 执行一批计划。
   * @param {Array} plans  计划对象（用 plan.priority 升序、plan.mutexKey 互斥）
   * @param {Function} executor (plan, index) => Promise<{ok:boolean,...}>
   * @returns {Promise<Array>} 与入参**同序**的结果数组
   */
  async function dispatch(plans = [], executor = async () => ({ ok: true })) {
    const list = (plans || []).map((plan, i) => ({ plan, i }));
    list.sort((a, b) => (Number(a.plan?.priority ?? 100) - Number(b.plan?.priority ?? 100)) || a.i - b.i);

    const results = new Array(list.length);
    const busy = new Set();       // 正在占用的互斥键
    const started = new Set();    // 已启动的任务下标（list 下标）
    const active = new Set();     // 进行中的 promise
    let running = 0;

    const startOne = (li) => {
      const { plan, i } = list[li];
      started.add(li);
      running++;
      stats.started++;
      if (running > stats.peak) stats.peak = running;
      const key = plan?.mutexKey;
      if (key) busy.add(key);
      const p = (async () => {
        let r;
        try {
          // 限速：自适应限速器优先（它自己算冷却/暂停/恢复），否则退回旧的固定间隔
          if (limiter) {
            const w = limiter.waitMs();
            if (w > 0) {
              stats.waitedMs += w;
              await sleep(w);
            }
            limiter.markStart();
          } else if (minGapMs) {
            const gap = now() - lastStart;
            if (gap < minGapMs) {
              stats.waitedMs += minGapMs - gap;
              await sleep(minGapMs - gap);
            }
            lastStart = now();
          }
          r = await executor(plan, i);
          // 反馈给限速器：WAF 降速 / 成功恢复试探
          if (limiter) {
            if (r && (r.waf === true || r.stage === 'waf' || r.error === 'WAF_BLOCKED')) {
              stats.waf++;
              limiter.onWaf(r.error || r.stage || 'waf');
            } else if (!r || r.ok !== false) {
              limiter.onSuccess();
            }
          }
        } catch (e) {
          r = { ok: false, error: String(e?.message || e) };
          if (limiter) limiter.onSuccess(); // 业务异常不算 WAF，不降速
        }
        results[i] = r === undefined ? { ok: true } : r;
        return results[i];
      })().finally(() => {
        running--;
        if (key) busy.delete(key);
        active.delete(p);
        if (results[i] && results[i].ok === false) stats.failed++;
        else stats.done++;
      });
      active.add(p);
      return p;
    };

    /** 尽力填满并发槽位：跳过被互斥键阻塞的任务，保持优先级顺序 */
    const fill = () => {
      for (let li = 0; li < list.length; li++) {
        if (running >= limit) break;
        if (started.has(li)) continue;
        const key = list[li].plan?.mutexKey;
        if (key && busy.has(key)) continue; // 该键正忙 → 让后面的先跑（提高吞吐）
        startOne(li);
      }
    };

    for (;;) {
      fill();
      if (running === 0) break;      // 没有在跑的 → 全部结束
      if (!active.size) break;       // 防御：不该发生
      await Promise.race([...active]); // 等任一完成，再尝试填槽
    }
    return results;
  }

  return { dispatch, stats: () => ({ ...stats }), limit, minGapMs };
}