// 插件执行器（B4，2026-11-19）：并行规划 → 优先级排序 → 调度（并发度可配）→ 统一发送。
//
// 内核只需调 runPluginPlans 一个函数。三种模式（config.plugins.<id>）：
//   false/undefined → 不跑该插件（走旧块）
//   'shadow'        → 跑规划但**不发送**，把 plans 打日志供与旧块对比（双轨）
//   true            → 跑规划并真发送；旧块跳过
//
// 为什么单独成模块：collect 已经 2260 行，接入逻辑放这里才不会继续膨胀；
// 同时这段逻辑可被单测（注入 plugins/compose/sendLayer）。

import { dispatchPlanBatch } from './plugins.mjs';
import { createQueue } from './exec-queue.mjs';
import { createSendLayer, bookkeep } from './send-layer.mjs';
import { createWorkerPool } from './worker-pool.mjs';
import { createMultiQueue } from './multi-queue.mjs';
import { createAdaptiveRate } from './rate-adapt.mjs';

/**
 * @param {object} o
 * @param {Array} o.plugins        loadPlugins 结果
 * @param {Array} o.results        本轮逐帖判定结果
 * @param {object} o.config
 * @param {object} o.state
 * @param {object} o.db            postDb（幂等事件）
 * @param {object} [o.usage]
 * @param {object} [o.runner]      opencli runner（真发时必需）
 * @param {object} [o.praiseDb]
 * @param {boolean} [o.dryRun]
 * @param {Function} [o.log]
 * @param {Function} o.hasDoneEvent (postId, kind, opts) => boolean
 * @param {Function} o.compose      生成回复（composeLlmReply）
 * @param {object} [o.sendLayerImpl] 注入（测试）
 * @param {object} [o.queueImpl]     注入（测试）
 * @returns {Promise<{mode:string, plans:Array, sent:number, failed:number, dryRun:boolean}>}
 */
export async function runPluginPlans({
  plugins = [],
  results = [],
  config = {},
  state = {},
  db = null,
  usage = null,
  runner = null,
  praiseDb = null,
  dryRun = false,
  log = () => {},
  hasDoneEvent = () => false,
  compose = null,
  sendLayerImpl = null,
  queueImpl = null,
} = {}) {
  const mode = resolveMode(config);
  if (!mode) return { mode: 'off', plans: [], sent: 0, failed: 0, dryRun };

  const ctx = { config, log, state, db, dryRun, hasDoneEvent, compose };
  const plans = await dispatchPlanBatch(plugins, results, ctx);
  if (!plans.length) return { mode, plans: [], sent: 0, failed: 0, dryRun };

  // shadow：只打日志，不发送
  if (mode === 'shadow') {
    log(`  [插件·shadow] 规划出 ${plans.length} 条计划（不发送）：`);
    for (const p of plans) {
      log(`    · ${p.plugin}/${p.kind} → ${p.postId}《${String(p.title || '').slice(0, 20)}》${String(p.text || '').slice(0, 40)}`);
    }
    return { mode, plans, sent: 0, failed: 0, dryRun: true };
  }

  // real：调度 + 发送
  //   · 线程池模式（exec.workerPool.enabled && size>1）→ multi-queue 分发到 N 个 worker_threads，
  //     worker 只发送（persist:false），**父进程 bookkeep 记账**（唯一写者，避免并发写库）
  //   · 否则 → 单线程 exec-queue + send-layer（等价旧行为）
  let queue = queueImpl;
  let layer = sendLayerImpl;
  let pool = null;
  const usePool = config?.exec?.workerPool?.enabled === true && Number(config?.exec?.workerPool?.size ?? 1) > 1 && !queueImpl;
  // 自适应限速器（T21）：默认全速，只在检出 WAF 时退避。多队列/单队列**共用同一个**实例 ——
  //   WAF 是按 IP 判的，各队列各自限速反而会一起被打。
  const rate = queueImpl ? null : createAdaptiveRate({ config, log });

  if (usePool) {
    pool = createWorkerPool({
      size: Number(config.exec.workerPool.size ?? 2),
      config,
      session: config.reply?.session || 'tap',
      taskTimeoutMs: Number(config.exec.workerPool.taskTimeoutMs ?? 120000),
      log,
    });
    log(`  [插件] 线程池模式：${config.exec.workerPool.size} 线程 + 多队列`);
    queue = createMultiQueue({ config, pool, rate, log });
    layer = {
      // 线程池下：worker 已发送 → 父进程只补记账
      send: async (plan, ctx) => {
        const r = await pool.run(plan);
        bookkeep(plan, r, { config: ctx.config, state: ctx.state, db: ctx.db, usage: ctx.usage, log: ctx.log || log });
        return r;
      },
    };
  } else if (!queue) {
    queue = createQueue({ concurrency: Number(config.exec?.concurrency ?? 1), rateLimit: config.exec?.rateLimit || null, rate, log });
  }
  if (!layer) layer = createSendLayer();

  let sent = 0;
  let failed = 0;
  try {
    await queue.dispatch(plans, async (plan) => {
      if (dryRun) {
        log(`  -- [dry-run] ${plan.plugin}/${plan.kind}：${String(plan.title || '').slice(0, 20)}`);
        log(`      | ${plan.text}`);
        return { ok: true, dryRun: true };
      }
      const r = await layer.send(plan, { config, state, db, runner, praiseDb, log, dryRun: false, usage });
      if (r.ok) {
        sent++;
        log(`    [OK] ${plan.plugin} 已发送（${plan.kind}）`);
      } else if (!r.skipped) {
        failed++;
        log(`    [FAIL] ${plan.plugin} 发送失败（${r.stage || r.reason}）`);
      }
      return r;
    });
  } finally {
    if (pool) { try { pool.close(); } catch {} }
  }
  return { mode, plans, sent, failed, dryRun, poolStats: pool ? pool.stats() : null };
}

/** 读 config.plugins 决定模式：有任一插件为 true → real；只有 shadow → shadow；全关 → off */
export function resolveMode(config = {}) {
  const p = config.plugins || {};
  const vals = Object.values(p).filter((v) => v === true || v === 'shadow');
  if (!vals.length) return null;
  return vals.some((v) => v === true) ? 'real' : 'shadow';
}

/** 某插件是否应由新路径接管（内核据此跳过旧块） */
export function pluginOwns(config = {}, id = '') {
  return config?.plugins?.[id] === true;
}