// worker 线程：只做「发送」，**不写任何库/文件**（B4-9b，2026-11-19）
//
// 为什么单独成线程：`opencli` 调用是 `spawnSync`（阻塞事件循环）。
// worker_threads 每线程独立事件循环 → 线程内阻塞不影响主线程与其他线程 → N 线程 = N 条真并行。
// 记账（state/SQLite/trace/usage）全部由父进程做，避免多线程并发写库互相覆盖。
import { parentPort, workerData } from 'node:worker_threads';

const { config = {}, session = 'tap' } = workerData || {};

// 线程内把接口节流关到最小（节流由父进程的队列令牌桶统一控制）
const cfg = {
  ...config,
  reply: { ...(config.reply || {}), apiIntervalMs: 0 },
};

const [{ createSendLayer }, { makeRunner }] = await Promise.all([
  import('../lib/send-layer.mjs'),
  import('../lib/replier.mjs'),
]);

const runner = makeRunner({ opencliMain: cfg.reply?.opencliMain, session });
const layer = createSendLayer();

parentPort.on('message', async (msg) => {
  if (!msg || msg.type !== 'send') {
    if (msg?.type === 'shutdown') process.exit(0);
    return;
  }
  const { id, plan } = msg;
  try {
    const r = await layer.send(plan, {
      config: cfg,
      runner,
      log: () => {},
      persist: false, // 只发送：不碰 state/db/usage/trace
    });
    parentPort.postMessage({ type: 'result', id, ok: Boolean(r?.ok), stage: r?.stage, detail: r?.detail, reason: r?.reason, skipped: r?.skipped });
  } catch (e) {
    parentPort.postMessage({ type: 'result', id, ok: false, stage: 'worker_error', error: String(e?.message || e) });
  }
});

parentPort.postMessage({ type: 'ready' });