// 插件：weekly（周报，P4-c，2026-11-19）
//
// 数据全部来自本地：近 N 天 reports/trace-<date>.jsonl + usage + 答疑库条数。
// 不调任何外部接口（零风险），产出 reports/周报-<from>_<to>.md。
//
// 触发：collect 每日整理时按 config.weekly.everyDays 判断（与 P4-d 同款），或手动
//   node scripts/report-weekly.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SKILL_ROOT } from '../lib/paths.mjs';
import { summarizeTrace } from '../lib/trace.mjs';
import { renderWeekly } from '../lib/weekly-report.mjs';
import { loadQaLibrary } from '../lib/qa.mjs';

const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const reportsDirOf = (config) => String(config?.paths?.reportsDir || resolve(SKILL_ROOT, 'reports')).replace(/\{\{SKILL\}\}/g, SKILL_ROOT);

/** 读某日 trace */
function readDayTrace(config, dateStr) {
  const f = resolve(reportsDirOf(config), `trace-${dateStr}.jsonl`);
  try {
    return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** 是否该跑周报（距上次 ≥ everyDays 天） */
export function shouldRunWeeklyReport(usage = {}, { everyDays = 7, now = new Date() } = {}) {
  if (usage?.weekly === false) return false;
  const last = usage?.lastWeeklyAt ? Date.parse(usage.lastWeeklyAt) : 0;
  if (!last) return true;
  return now.getTime() - last >= Number(everyDays) * 86400000;
}

export default {
  id: 'weekly',
  name: '周报',

  /** 生成周报（不判断该不该跑，由调用方决定） */
  async build(ctx = {}) {
    const { config = {}, log = () => {}, usage = null, days = 7, now = new Date() } = ctx;
    const to = ymd(now);
    const fromD = new Date(now.getTime() - (Number(days) - 1) * 86400000);
    const from = ymd(fromD);

    const daily = [];
    const rows = [];
    for (let i = 0; i < Number(days); i++) {
      const d = new Date(fromD.getTime() + i * 86400000);
      const ds = ymd(d);
      const r = readDayTrace(config, ds);
      rows.push(...r);
      daily.push({ date: ds, summary: summarizeTrace(r) });
    }

    // 知识库规模
    let qaCount = 0;
    try { qaCount = (await loadQaLibrary(config.paths?.qaFile)).length; } catch {}
    let facts = 0;
    try {
      const { openDb } = await import('../lib/db.mjs');
      const { listFacts } = await import('../lib/facts.mjs');
      facts = listFacts(openDb(config.paths.postDbFile)).length;
    } catch {}

    const md = renderWeekly({
      from, to, daily, rows,
      usage: usage || null,
      config,
      libStats: { qaAfter: qaCount, facts },
    });
    const out = resolve(reportsDirOf(config), `周报-${from}_${to}.md`);
    mkdirSync(resolve(out, '..'), { recursive: true });
    writeFileSync(out, md);
    const sent = daily.reduce((a, d) => a + (d.summary?.sent || 0), 0);
    const abstain = daily.reduce((a, d) => a + (d.summary?.abstain || 0), 0);
    log(`  [周报] ${from}~${to}：发送 ${sent} / 弃答 ${abstain} → ${out}`);
    return { ok: true, out, from, to, sent, abstain, days: Number(days) };
  },

  /** scheduled 钩子：按 everyDays 判断后生成 */
  async scheduled(ctx = {}) {
    const { config = {}, log = () => {}, usage = null } = ctx;
    if (config.weekly?.enabled === false) return { skipped: 'disabled' };
    if (!shouldRunWeeklyReport(usage, { everyDays: Number(config.weekly?.everyDays ?? 7) })) {
      return { skipped: 'not_due' };
    }
    return this.build({ ...ctx, days: Number(config.weekly?.days ?? 7) });
  },
};