// O2 日报渲染（B1.5，2026-11-18）：trace → 人看的 Markdown。纯函数，便于测试。
// 摘要指标来自 trace.summarizeTrace；本模块只负责渲染与「值得注意」的聚合。

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '-');

/**
 * @param {object} o
 * @param {object} o.summary summarizeTrace 结果
 * @param {Array}  o.rows    原始 trace 行（可选，用于明细）
 * @param {string} o.date    YYYY-MM-DD
 * @param {object} o.config
 */
export function renderDaily({ summary = {}, rows = [], date = '', config = {}, llmUsage = null } = {}) {
  const s = summary;
  const L = [];
  L.push(`# 答疑日报 ${date}`);
  L.push('');
  L.push(`> 生成于 ${new Date().toLocaleString('zh-CN')} ｜ pipeline=${config?.pipeline || '-'} ｜ dense=${config?.retrieve?.denseBackend || '-'} ｜ rerank=${config?.rerank?.backend || '-'}`);
  if (llmUsage) {
    const cap = Number(config?.llm?.dailyCallCap ?? 0);
    L.push(`> LLM 调用：今日 **${llmUsage.calls}** 次${cap > 0 ? `（上限 ${cap}，剩余 ${Math.max(0, cap - llmUsage.calls)}）` : '（未设上限）'}`);
  }
  L.push('');
  L.push('| 指标 | 值 |');
  L.push('|---|---|');
  L.push(`| trace 条数 | ${s.total ?? 0} |`);
  L.push(`| 已发送 | ${s.sent ?? 0} |`);
  L.push(`| 弃答（abstain/低置信） | ${s.abstain ?? 0} |`);
  L.push(`| 忠实度失败（转人工） | ${s.faithFail ?? 0} |`);
  L.push(`| 渠道失败次数（额外尝试） | ${s.channelFail ?? 0} |`);
  L.push(`| 平均生成耗时 | ${s.avgGenMs != null ? s.avgGenMs + ' ms' : '-'} |`);
  L.push('');

  const distTable = (title, obj = {}) => {
    const keys = Object.keys(obj || {}).sort((a, b) => obj[b] - obj[a]);
    if (!keys.length) return;
    L.push(`## ${title}`);
    L.push('');
    L.push('| 值 | 条数 | 占比 |');
    L.push('|---|---|---|');
    const total = keys.reduce((a, k) => a + obj[k], 0);
    for (const k of keys) L.push(`| ${k} | ${obj[k]} | ${pct(obj[k], total)} |`);
    L.push('');
  };
  distTable('按意图（intent 标签，仅观测）', s.byIntent);
  distTable('按分档（tier）', s.byTier);
  distTable('按事件', s.byEvent);

  // 值得注意：弃答、忠实度失败、多意图并行的帖（v2 意图并行观测点）
  const notes = [];
  const byPost = new Map();
  for (const r of rows) {
    if (!r.postId) continue;
    const cur = byPost.get(r.postId) || { postId: r.postId, title: r.title, events: [], tiers: [], reasons: [] };
    cur.events.push(r.event);
    if (r.tier) cur.tiers.push(r.tier);
    if (r.reason) cur.reasons.push(r.reason);
    if (r.title && !cur.title) cur.title = r.title;
    byPost.set(r.postId, cur);
  }
  for (const v of byPost.values()) {
    if (v.reasons.includes('faithfulness_fail')) notes.push(`忠实度自检不通过 → 转人工：《${v.title || v.postId}》`);
    else if (v.tiers.includes('abstain')) notes.push(`分档弃答：《${v.title || v.postId}》`);
  }
  if (notes.length) {
    L.push('## 值得注意');
    L.push('');
    for (const n of notes.slice(0, 20)) L.push(`- ${n}`);
    L.push('');
  }

  // 多意图/多事件帖（并行规划的观测依据：一帖多事件说明多通道同时跟进）
  const multi = [...byPost.values()].filter((v) => new Set(v.events).size >= 3);
  if (multi.length) {
    L.push('## 单帖多事件（多通道并行跟进）');
    L.push('');
    for (const v of multi.slice(0, 10)) L.push(`- 《${v.title || v.postId}》：${[...new Set(v.events)].join(' → ')}`);
    L.push('');
  }

  if (!rows.length) L.push('_今日无 trace 记录（守护未运行或 trace 关闭）_');
  return L.join('\n');
}