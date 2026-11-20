// O2 结构化 trace（2026-11-18）：每帖一行 JSONL，供误答归因/成本统计/日报/评测候选回收。
// 设计：append-only（不重写整份），按日滚 trace-<YYYY-MM-DD>.jsonl，保留 config.trace.keepDays 天。
// 用户 2026-11-18 决策：**不设每日发送闸**（dailyCap 不做），只加 trace 观测。
import { appendFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SKILL_ROOT } from './paths.mjs';

const dayOf = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function traceFile(config, d = new Date()) {
  const dir = config?.paths?.reportsDir
    ? String(config.paths.reportsDir).replace(/\{\{SKILL\}\}/g, SKILL_ROOT)
    : resolve(SKILL_ROOT, 'reports');
  return resolve(dir, `trace-${dayOf(d)}.jsonl`);
}

/**
 * 记一条 trace。字段按需给，缺省不写。
 * @param {object} o {config, postId, event, intent, source, entryId, score, tier, judgeOk,
 *                    faithOk, genMs, channelsTried, sent, kind, reason, note,
 *                    phase, ms}   // 2026-11-20：phase = fetch_list/fetch_comments/compose/send
 */
export function trace(o = {}) {
  const { config = {}, event = 'step' } = o;
  if (config?.trace?.enabled === false) return null;
  const row = { ts: new Date().toISOString(), event };
  for (const k of ['postId', 'intent', 'source', 'entryId', 'score', 'tier', 'judgeOk', 'faithOk', 'genMs', 'channelsTried', 'sent', 'kind', 'reason', 'phase', 'ms']) {
    if (o[k] !== undefined && o[k] !== null) row[k] = o[k];
  }
  // 标题只留 40 字（人看够用，不落作者 id / 不落全文）
  if (o.title) row.title = String(o.title).replace(/\s+/g, ' ').trim().slice(0, 40);
  if (o.note) row.note = String(o.note).slice(0, 160);
  try {
    const f = traceFile(config);
    mkdirSync(resolve(f, '..'), { recursive: true });
    appendFileSync(f, JSON.stringify(row) + '\n');
    return f;
  } catch {
    return null; // trace 失败绝不影响主流程
  }
}

/** 裁剪：删掉超过 keepDays 的 trace 文件（每日整理时调一次）。 */
export function pruneTrace(config, { keepDays = 14, now = new Date() } = {}) {
  const dir = resolve(traceFile(config, now), '..');
  if (!existsSync(dir)) return { removed: 0 };
  const cutoff = now.getTime() - keepDays * 86400000;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    const m = f.match(/^trace-(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
    if (!m) continue;
    const t = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).getTime();
    if (t < cutoff) {
      try { unlinkSync(resolve(dir, f)); removed++; } catch {}
    }
  }
  return { removed };
}

/** 读某日 trace（日报/评测回收用）。 */
export function readTrace(config, d = new Date()) {
  try {
    const text = readFileSync(traceFile(config, d), 'utf8');
    return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

/** 汇总某日 trace → 日报数据（O2/E2E 报表用）。 */
export function summarizeTrace(rows = []) {
  const out = { total: rows.length, byEvent: {}, byIntent: {}, byTier: {}, sent: 0, abstain: 0, faithFail: 0, avgGenMs: null, channelFail: 0 };
  let genSum = 0, genN = 0;
  for (const r of rows) {
    out.byEvent[r.event] = (out.byEvent[r.event] || 0) + 1;
    if (r.intent) out.byIntent[r.intent] = (out.byIntent[r.intent] || 0) + 1;
    if (r.tier) out.byTier[r.tier] = (out.byTier[r.tier] || 0) + 1;
    if (r.sent === true) out.sent++;
    if (r.tier === 'abstain' || r.reason === 'abstain_low_conf') out.abstain++;
    if (r.reason === 'faithfulness_fail' || r.faithOk === false) out.faithFail++;
    if (Number.isFinite(r.genMs)) { genSum += r.genMs; genN++; }
    if (r.channelsTried > 1) out.channelFail += r.channelsTried - 1;
  }
  out.avgGenMs = genN ? Math.round(genSum / genN) : null;
  return out;
}