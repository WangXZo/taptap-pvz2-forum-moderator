// 线程池（B4-9b，2026-11-19）：N 个 worker_threads，各自独立事件循环 → 真并行发送。
// 设计要点：
//   · worker 只发送（persist:false），记账由父进程做
//   · 任务超时 → terminate 该线程 + 重建 + 该任务标失败（**不重试**，防重复发送）
//   · 连续启动失败 ≥ maxRestarts → 池禁用（调用方回退单线程）
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WORKER_URL = resolve(HERE, '..', 'workers', 'send-worker.mjs');

/**
 * @param {object} o
 * @param {number} [o.size=2]
 * @param {string} [o.workerUrl]
 * @param {object} o.config
 * @param {string} [o.session]
 * @param {number} [o.taskTimeoutMs=120000]
 * @param {number} [o.maxRestarts=3]
 * @param {Function} [o.log]
 * @param {Function} [o.WorkerImpl] 注入 Worker 构造（测试用）
 */
export function createWorkerPool({
  size = 2,
  workerUrl = DEFAULT_WORKER_URL,
  config = {},
  session = 'tap',
  taskTimeoutMs = 120000,
  maxRestarts = 3,
  log = () => {},
  WorkerImpl = null,
} = {}) {
  const WorkerCtor = WorkerImpl || Worker;
  const n = Math.max(1, Number(size) || 1);
  const stats = { done: 0, failed: 0, restarts: 0, spawned: 0 };
  const slots = [];          // { w, busy, id, timer, terminate }
  const waiting = [];        // { plan, resolve }
  let closed = false;
  let disabled = false;
  let seq = 0;

  function spawnSlot() {
    if (closed || disabled) return null;
    try {
      const w = new WorkerCtor(workerUrl, { workerData: { config, session } });
      stats.spawned++;
      const slot = { w, busy: false, id: null, timer: null };
      slots.push(slot);
      w.on('message', (m) => {
        if (m?.type === 'ready') return;
        if (m?.type === 'result') finishSlot(slot, m);
      });
      w.on('error', (e) => {
        log(`  [线程池] worker error：${e?.message || e}`);
        failSlot(slot, { ok: false, stage: 'worker_error', error: String(e?.message || e) });
      });
      w.on('exit', (code) => {
        if (closed) return;
        const idx = slots.indexOf(slot);
        if (idx >= 0) slots.splice(idx, 1);
        if (slot.busy && slot.id != null) {
          settle(slot.id, { ok: false, stage: 'worker_exit', error: `exit ${code}` });
        }
        if (stats.restarts >= maxRestarts) {
          disabled = true;
          log(`  [线程池] 连续重建 ${maxRestarts} 次仍失败 → 池禁用（回退单线程）`);
          return;
        }
        stats.restarts++;
        spawnSlot();
        pump();
      });
      return slot;
    } catch (e) {
      log(`  [线程池] 启动失败：${e?.message || e}`);
      disabled = true;
      return null;
    }
  }

  const pendingMap = new Map(); // id -> {resolve, plan}

  function settle(id, result) {
    const item = pendingMap.get(id);
    if (!item) return;
    pendingMap.delete(id);
    if (result.ok) stats.done++;
    else stats.failed++;
    item.resolve(result);
  }

  function finishSlot(slot, msg) {
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    const id = slot.id;
    slot.busy = false;
    slot.id = null;
    if (id != null) settle(id, { ok: Boolean(msg.ok), stage: msg.stage, detail: msg.detail, reason: msg.reason, skipped: msg.skipped });
    pump();
  }

  function failSlot(slot, result) {
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
    const id = slot.id;
    slot.busy = false;
    slot.id = null;
    if (id != null) settle(id, result);
    try { slot.w.terminate(); } catch {}
    pump();
  }

  function pump() {
    if (closed || disabled) return;
    // 确保槽位数量足够
    while (slots.length < n) { if (!spawnSlot()) break; }
    for (const slot of slots) {
      if (!waiting.length) break;
      if (slot.busy) continue;
      const task = waiting.shift();
      const id = ++seq;
      slot.busy = true;
      slot.id = id;
      pendingMap.set(id, task);
      slot.w.postMessage({ type: 'send', id, plan: task.plan });
      slot.timer = setTimeout(() => {
        log(`  [线程池] 任务超时（${taskTimeoutMs}ms）→ terminate 线程重建，任务标失败（不重试）`);
        failSlot(slot, { ok: false, stage: 'timeout', error: `timeout ${taskTimeoutMs}ms` });
      }, taskTimeoutMs);
    }
  }

  return {
    /** 投递一个发送任务；返回 {ok, stage?, detail?} */
    run(plan) {
      if (closed || disabled) return Promise.resolve({ ok: false, stage: 'pool_disabled' });
      return new Promise((resolve) => {
        waiting.push({ plan, resolve });
        pump();
      });
    },
    stats: () => ({ ...stats, idle: slots.filter((s) => !s.busy).length, busy: slots.filter((s) => s.busy).length, queued: waiting.length, disabled }),
    close() {
      closed = true;
      for (const s of slots) { try { s.w.postMessage({ type: 'shutdown' }); s.w.terminate(); } catch {} }
      slots.length = 0;
      for (const item of pendingMap.values()) item.resolve({ ok: false, stage: 'pool_closed' });
      pendingMap.clear();
      waiting.length = 0;
    },
  };
}