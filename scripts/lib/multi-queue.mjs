// 多队列调度（B4-9c，2026-11-19）：按 kind 路由到不同队列，各队列独立并发度 + 独立令牌桶。
//
// 大哥要求「多线程 + 多队列并发」：
//   · **队列不是串行枷锁**，而是「分组限速」的容器 —— 队列之间并行、互不阻塞
//   · 队列 A 在等自己的限速时，队列 B 的任务可以立刻执行
//   · 同一 mutexKey（同一帖）仍严格串行，防同帖两条回复撞车
//
// 与 exec-queue 的分工：exec-queue 管「单队列内的优先级/互斥/限速」；
// 本模块管「多队列路由 + 队列级并发/限速 + 队列间并行」。未配置队列的 kind 落到 default。

const DEFAULT_QUEUE = 'default';

/**
 * plan → 队列名
 *
 * 三种模式（`exec.queues.mode`）：
 *   fixed     —— 旧的 3 条（answer / social / summon）。social 把 4 个捧场通道合在一起
 *   perPlugin —— **每个插件一条**：answer / praise / share / comfort / interact / summon
 *                → 答疑不再被夸奖堵住（大哥要的「队列不是终点」）
 *   perPost   —— 每帖一条（上限 `exec.maxQueues`），帖间完全并行
 *
 * @param {object} plan
 * @param {object} queues  config.exec.queues
 * @param {object} [opt]   {mode, maxQueues}
 */
export function queueOf(plan, queues = {}, { mode = 'fixed' } = {}) {
  const kind = String(plan?.kind || 'answer');
  if (mode === 'perPlugin') {
    // 插件名优先（同一 kind 可能来自不同插件，如 apology 走 interact 但 kind=summon）
    return String(plan?.plugin || kind);
  }
  if (mode === 'perPost') {
    const pid = String(plan?.postId || '');
    return pid ? `post:${pid}` : DEFAULT_QUEUE;
  }
  // fixed（默认）
  if (queues[kind]) return kind;                     // 显式同名队列
  if ((kind === 'praise' || kind === 'share' || kind === 'comfort' || kind === 'interact') && queues.social) return 'social';
  if (kind === 'answer' && queues.answer) return 'answer';
  if (kind === 'summon' && queues.summon) return 'summon';
  return DEFAULT_QUEUE;
}

/**
 * @param {object} o
 * @param {object} o.config
 * @param {object} [o.pool]   worker 池（有则用线程发送；否则用 sendFn 单线程）
 * @param {Function} o.sendFn (plan) => Promise<{ok,...}>  单线程发送（池不可用时）
 * @param {Function} [o.log]
 * @param {Function} [o.now]
 * @param {Function} [o.sleep]
 */
export function createMultiQueue({ config = {}, pool = null, sendFn = null, rate = null, log = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const execCfg = config.exec || {};
  const cfgQueues = execCfg.queues || {};
  const mode = String(cfgQueues.mode || 'fixed');
  const maxQueues = Math.max(1, Number(execCfg.maxQueues ?? 32));
  const globalConc = Math.max(1, Number(execCfg.concurrency) || 1);
  const globalPerSec = Number(execCfg.rateLimit?.perSecond) || 0;
  // 自适应限速器（lib/rate-adapt.mjs）：给了就用**全局共享**一个 ——
  //   WAF 是按 IP 判的，各队列各自限速反而会一起被打
  const limiter = rate || null;

  const names = new Set([...Object.keys(cfgQueues), DEFAULT_QUEUE]);
  const state = {};
  for (const name of names) {
    if (name === 'mode') continue;
    const q = cfgQueues[name] || {};
    state[name] = {
      concurrency: Math.max(1, Number(q.concurrency ?? globalConc)),
      minGapMs: Number(q.perSecond ?? globalPerSec) > 0 ? Math.ceil(1000 / Number(q.perSecond ?? globalPerSec)) : 0,
      running: 0,
      lastStart: 0,
      pending: [],
    };
  }
  const stats = { done: 0, failed: 0, peak: 0, waf: 0, waitedMs: 0, byQueue: {}, queueCount: 0 };
  const busyKeys = new Set();

  /** 取队列状态；队列数超 maxQueues 时降级到 default */
  function resolveQueue(qn0) {
    let qn = qn0;
    if (!state[qn]) {
      if (Object.keys(state).length >= maxQueues) qn = DEFAULT_QUEUE;
      if (!state[qn]) {
        state[qn] = {
          concurrency: globalConc,
          minGapMs: globalPerSec ? Math.ceil(1000 / globalPerSec) : 0,
          running: 0,
          lastStart: 0,
          pending: [],
        };
      }
    }
    stats.queueCount = Object.keys(state).length;
    return { name: qn, qs: state[qn] };
  }

  /**
   * @param {Array} plans
   * @param {Function} [executor] 单条执行器 `(plan) => Promise<result>`
   *   ⚠️ 2026-11-23 必须支持（F0）：plugin-runner 传进来的执行器里包着
   *      `layer.send`（= pool.run + **bookkeep 记账**）与 sent/failed 计数。
   *      以前这里签名只收 plans、把第二个参数**静默丢掉** → 线程池模式下
   *      直接 `pool.run` 发送，记账/计数/日志整条链全不执行：
   *        · 评论真的发出去了，但 post_event 没事件、state 没标记、trace 没记录
   *        · 日志恒为「本轮执行 0 条（失败 0）」
   *        · 幂等门失效 → 同轮旧块再发一次 = **同帖双发**（帖 873562347409509277 实测）
   * @returns {Promise<Array>} 与入参**同序**结果
   */
  async function dispatch(plans = [], executor = null) {
    const list = (plans || []).map((plan, i) => ({ plan, i }));
    const results = new Array(list.length);
    // 按队列分组（队列内按 priority 升序）
    for (const item of list) {
      const { name, qs } = resolveQueue(queueOf(item.plan, cfgQueues, { mode }));
      item.__queue = name;
      qs.pending.push(item);
    }
    for (const qn of Object.keys(state)) {
      state[qn].pending.sort((a, b) => (Number(a.plan?.priority ?? 100) - Number(b.plan?.priority ?? 100)) || a.i - b.i);
    }

    const active = new Set();
    let totalRunning = 0;

    const startOne = (qn, item) => {
      const qs = state[qn];
      qs.running++;
      totalRunning++;
      if (totalRunning > stats.peak) stats.peak = totalRunning;
      stats.byQueue[qn] = stats.byQueue[qn] || { done: 0, failed: 0, started: 0 };
      stats.byQueue[qn].started++;
      const key = item.plan?.mutexKey;
      if (key) busyKeys.add(key);
      const p = (async () => {
        let r;
        try {
          // 限速：自适应限速器优先（全局共享），否则用队列级固定令牌桶
          if (limiter) {
            const w = limiter.waitMs();
            if (w > 0) {
              stats.waitedMs += w;
              await sleep(w);
            }
            limiter.markStart();
          } else if (qs.minGapMs) {
            const gap = now() - qs.lastStart;
            if (gap < qs.minGapMs) {
              stats.waitedMs += qs.minGapMs - gap;
              await sleep(qs.minGapMs - gap);
            }
            qs.lastStart = now();
          }
          // 优先用调用方的执行器（里面含记账/计数/日志）；
          // 没给才退回裸 pool.run / sendFn（历史行为，仅供不记账的场景）。
          r = executor
            ? await executor(item.plan)
            : pool
              ? await pool.run(item.plan)
              : await sendFn(item.plan);
          // 反馈给限速器
          if (limiter) {
            if (r && (r.waf === true || r.stage === 'waf' || r.error === 'WAF_BLOCKED')) {
              stats.waf++;
              limiter.onWaf(r.error || r.stage || 'waf');
            } else if (!r || r.ok !== false) {
              limiter.onSuccess();
            }
          }
        } catch (e) {
          r = { ok: false, stage: 'exception', error: String(e?.message || e) };
          if (limiter) limiter.onSuccess(); // 业务异常不算 WAF
        }
        results[item.i] = r === undefined ? { ok: true } : r;
        return results[item.i];
      })().finally(() => {
        qs.running--;
        totalRunning--;
        if (key) busyKeys.delete(key);
        active.delete(p);
        if (results[item.i] && results[item.i].ok === false) { stats.failed++; stats.byQueue[qn].failed++; }
        else { stats.done++; stats.byQueue[qn].done++; }
      });
      active.add(p);
    };

    /** 从各队列挑可启动任务（队列间轮询，保证公平） */
    const fill = () => {
      let launched = false;
      let progress = true;
      while (progress) {
        progress = false;
        for (const qn of Object.keys(state)) {
          const qs = state[qn];
          if (qs.running >= qs.concurrency) continue;
          // 找该队列中第一个没被 mutex 阻塞的任务
          const idx = qs.pending.findIndex((it) => {
            const key = it.plan?.mutexKey;
            return !key || !busyKeys.has(key);
          });
          if (idx < 0) continue;
          const [item] = qs.pending.splice(idx, 1);
          startOne(qn, item);
          launched = true;
          progress = true;
        }
      }
      return launched;
    };

    for (;;) {
      fill();
      if (totalRunning === 0) {
        // 还有 pending 但都被 mutex 阻塞且无运行 → 不应发生；防御性退出
        if (!Object.values(state).some((q) => q.pending.length)) break;
        if (!active.size) break;
      }
      if (!active.size) break;
      await Promise.race([...active]);
    }
    return results;
  }

  return { dispatch, stats: () => ({ ...stats }), queueState: () => state };
}