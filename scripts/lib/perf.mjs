// 阶段耗时打点（2026-11-20 · T20）
//
// 为什么先做这个：任何性能优化，**没有数据就是瞎猜**。
// 实测直觉是「LLM 组答占 80%」，但没量过。先埋点，再优化。
//
// 用法（一处埋点覆盖所有调用方）：
//   const t = begin();
//   ...干活...
//   phaseTrace(config, 'compose', begin());     // 或 stop(t)
//
// 设计约束：
//   · trace 写失败绝不影响主流程（复用 trace 的 try/catch）
//   · 用 hrtime.bigint，亚毫秒精度
//   · phase 名保持固定枚举，便于统计（不要随意加，否则报表碎掉）

import { trace } from './trace.mjs';

/** 固定 phase 名：改这里要同步 report-perf.mjs */
export const PHASES = {
  fetchList: 'fetch_list',
  fetchDetail: 'fetch_detail',
  fetchComments: 'fetch_comments',
  compose: 'compose',
  send: 'send',
  image: 'image',
};

/** 开始计时（返回 hrtime bigint） */
export function begin() {
  return process.hrtime.bigint();
}

/** 结束并返回毫秒（整数） */
export function since(t0) {
  if (!t0) return null;
  return Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
}

/**
 * 打一条 phase trace
 * @param {object} config
 * @param {string} phase  PHASES 里的值
 * @param {bigint} t0     begin() 的返回值
 * @param {object} [extra] {postId, note}
 */
export function phaseTrace(config, phase, t0, extra = {}) {
  const ms = since(t0);
  if (ms === null) return null;
  return trace({ config, event: 'phase', phase, ms, ...extra });
}

/**
 * 包一个同步/异步函数并自动打点
 * @returns 原函数的返回值
 */
export async function timed(config, phase, fn, extra = {}) {
  const t0 = begin();
  try {
    return await fn();
  } finally {
    phaseTrace(config, phase, t0, typeof extra === 'function' ? extra() : extra);
  }
}

/** 取百分位（已排序数组） */
function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/**
 * 汇总 phase trace 行 → 每个 phase 的 count / avg / p50 / p90 / max
 * @param {Array} rows  readTrace() 的结果
 */
export function summarizePerf(rows = []) {
  const by = {};
  for (const r of rows) {
    if (r?.event !== 'phase' || !r.phase || !Number.isFinite(r.ms)) continue;
    (by[r.phase] = by[r.phase] || []).push(Number(r.ms));
  }
  const out = {};
  let totalAvg = 0;
  let totalN = 0;
  for (const [phase, list] of Object.entries(by)) {
    const sorted = [...list].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    out[phase] = {
      count: sorted.length,
      avg: Math.round(sum / sorted.length),
      p50: pct(sorted, 50),
      p90: pct(sorted, 90),
      max: sorted[sorted.length - 1],
      sum,
    };
    totalAvg += sum;
    totalN += sorted.length;
  }
  // 每帖平均总耗时（用 phase 出现次数最少的那类做分母会更准，但这里取「compose 次数」近似一帖一次组答）
  const postish = out[PHASES.compose]?.count || out[PHASES.fetchComments]?.count || 0;
  return {
    byPhase: out,
    totalMs: totalAvg,
    samples: totalN,
    perPostMs: postish ? Math.round(totalAvg / postish) : null,
  };
}

/** 渲染成 Markdown 报告 */
export function renderPerf(summary, { date = '', config = {} } = {}) {
  const L = [];
  L.push(`# 耗时分布 ${date}`);
  L.push('');
  if (!summary.samples) {
    L.push('> 这个时间段没有 phase 打点记录。');
    L.push('> 打点从 2026-11-20 起生效；之前跑的守护不会产生这类记录。');
    return L.join('\n');
  }
  L.push(`样本 ${summary.samples} 条 ｜ 总耗时 ${(summary.totalMs / 1000).toFixed(1)} 秒${summary.perPostMs ? ` ｜ 平均每帖 ${summary.perPostMs} ms` : ''}`);
  L.push('');
  L.push('| 阶段 | 次数 | 平均 | p50 | p90 | 最大 | 合计占比 |');
  L.push('|---|---|---|---|---|---|---|');
  const order = [PHASES.fetchList, PHASES.fetchDetail, PHASES.fetchComments, PHASES.compose, PHASES.send, PHASES.image];
  const keys = [...order.filter((k) => summary.byPhase[k]), ...Object.keys(summary.byPhase).filter((k) => !order.includes(k))];
  for (const k of keys) {
    const v = summary.byPhase[k];
    const share = summary.totalMs ? Math.round((v.sum / summary.totalMs) * 100) : 0;
    L.push(`| ${k} | ${v.count} | ${v.avg} ms | ${v.p50} ms | ${v.p90} ms | ${v.max} ms | ${share}% |`);
  }
  L.push('');
  const top = keys.map((k) => [k, summary.byPhase[k]]).sort((a, b) => b[1].sum - a[1].sum)[0];
  if (top) {
    L.push(`**瓶颈：\`${top[0]}\`** 占 ${Math.round((top[1].sum / summary.totalMs) * 100)}%（平均 ${top[1].avg} ms / 次）。`);
    L.push('');
  }
  L.push('> 优化顺序：先压占比最大的那个阶段；`send` 变慢通常是 WAF 或浏览器通道，`compose` 慢是 LLM 渠道。');
  return L.join('\n');
}