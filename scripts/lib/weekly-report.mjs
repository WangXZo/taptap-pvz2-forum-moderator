// P4-c weekly 周报渲染（2026-11-19）：把近 N 天的 trace/usage/QA 变化汇总成一份周报 md。
// 纯函数，便于测试；数据收集由 plugins/weekly.mjs 负责。

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '-');

/**
 * @param {object} o
 * @param {string} o.from   起始日期 YYYY-MM-DD
 * @param {string} o.to     结束日期 YYYY-MM-DD
 * @param {Array<{date, summary}>} o.daily  每日汇总（summarizeTrace 结果）
 * @param {Array} [o.rows]  原始 trace 行（用于明细/异常）
 * @param {object} [o.usage]
 * @param {object} [o.config]
 * @param {object} [o.libStats] {qaBefore, qaAfter, facts, archived}
 */
export function renderWeekly({ from = '', to = '', daily = [], rows = [], usage = null, config = {}, libStats = {} } = {}) {
  const total = daily.reduce(
    (a, d) => {
      const s = d.summary || {};
      a.trace += s.total || 0;
      a.sent += s.sent || 0;
      a.abstain += s.abstain || 0;
      a.faithFail += s.faithFail || 0;
      a.channelFail += s.channelFail || 0;
      if (Number.isFinite(s.avgGenMs)) { a.genSum += s.avgGenMs; a.genN++; }
      for (const [k, v] of Object.entries(s.byIntent || {})) a.byIntent[k] = (a.byIntent[k] || 0) + v;
      for (const [k, v] of Object.entries(s.byTier || {})) a.byTier[k] = (a.byTier[k] || 0) + v;
      return a;
    },
    { trace: 0, sent: 0, abstain: 0, faithFail: 0, channelFail: 0, genSum: 0, genN: 0, byIntent: {}, byTier: {} }
  );

  const L = [];
  L.push(`# 答疑周报 ${from} ~ ${to}`);
  L.push('');
  L.push(`> 生成于 ${new Date().toLocaleString('zh-CN')} ｜ pipeline=${config?.pipeline || '-'} ｜ dense=${config?.retrieve?.denseBackend || '-'} ｜ rerank=${config?.rerank?.backend || '-'}`);
  L.push('');
  L.push('## 总览');
  L.push('');
  L.push('| 指标 | 合计 |');
  L.push('|---|---|');
  L.push(`| trace 事件 | ${total.trace} |`);
  L.push(`| 已发送 | ${total.sent} |`);
  L.push(`| 弃答（abstain/低置信） | ${total.abstain} |`);
  L.push(`| 忠实度失败 | ${total.faithFail} |`);
  L.push(`| 渠道失败（额外尝试） | ${total.channelFail} |`);
  L.push(`| 平均生成耗时 | ${total.genN ? Math.round(total.genSum / total.genN) + ' ms' : '-'} |`);
  L.push('');

  if (daily.length) {
    L.push('## 每日趋势');
    L.push('');
    L.push('| 日期 | trace | 发送 | 弃答 | 忠实失败 |');
    L.push('|---|---|---|---|---|');
    for (const d of daily) {
      const s = d.summary || {};
      L.push(`| ${d.date} | ${s.total ?? 0} | ${s.sent ?? 0} | ${s.abstain ?? 0} | ${s.faithFail ?? 0} |`);
    }
    L.push('');
  }

  const distTable = (title, obj) => {
    const keys = Object.keys(obj || {}).sort((a, b) => obj[b] - obj[a]);
    if (!keys.length) return;
    L.push(`## ${title}`);
    L.push('');
    L.push('| 值 | 次数 | 占比 |');
    L.push('|---|---|---|');
    const sum = keys.reduce((a, k) => a + obj[k], 0);
    for (const k of keys) L.push(`| ${k} | ${obj[k]} | ${pct(obj[k], sum)} |`);
    L.push('');
  };
  distTable('意图分布（标签，仅观测）', total.byIntent);
  distTable('分档分布', total.byTier);

  // 知识库变化
  const ls = libStats || {};
  const hasLib = ['qaBefore', 'qaAfter', 'facts', 'archived'].some((k) => ls[k] !== undefined);
  if (hasLib) {
    L.push('## 知识库变化');
    L.push('');
    if (ls.qaBefore !== undefined && ls.qaAfter !== undefined) {
      L.push(`- 答疑库：${ls.qaBefore} → ${ls.qaAfter} 条（净 ${ls.qaAfter - ls.qaBefore >= 0 ? '+' : ''}${ls.qaAfter - ls.qaBefore}）`);
    }
    if (ls.facts !== undefined) L.push(`- facts：${ls.facts} 条`);
    if (ls.archived) L.push(`- 本期归档：${ls.archived} 条`);
    L.push('');
  }

  // 引用 top（哪些知识真被用到）
  if (usage?.items) {
    const top = Object.entries(usage.items)
      .filter(([, v]) => Number(v?.cited || 0) > 0)
      .sort((a, b) => b[1].cited - a[1].cited)
      .slice(0, 10);
    if (top.length) {
      L.push('## 被引用最多的知识');
      L.push('');
      L.push('| 引用 | 条目 |');
      L.push('|---|---|');
      for (const [k, v] of top) L.push(`| ${v.cited} | ${String(k).slice(0, 46)} |`);
      L.push('');
    }
  }

  // 异常提示
  const notes = [];
  if (total.faithFail > 0) notes.push(`忠实度自检未通过 ${total.faithFail} 次（已转人工，非线上错误）`);
  if (total.abstain > 0) notes.push(`弃答 ${total.abstain} 次（不确定即弃答，符合自治策略）`);
  if (total.channelFail > 0) notes.push(`LLM 渠道额外尝试 ${total.channelFail} 次（冷却机制会逐步减少）`);
  if (notes.length) {
    L.push('## 值得注意');
    L.push('');
    for (const n of notes) L.push(`- ${n}`);
    L.push('');
  }

  if (!total.trace) L.push('_本期无 trace 数据（守护未运行或 trace 关闭）_');
  return L.join('\n');
}