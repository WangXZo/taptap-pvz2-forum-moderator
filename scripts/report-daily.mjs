#!/usr/bin/env node
// O2 日报 CLI（B1.5，2026-11-18）：读 trace → reports/daily-<date>.md
//   node scripts/report-daily.mjs              # 今天
//   node scripts/report-daily.mjs --date 2026-11-18
//   node scripts/report-daily.mjs --out <file>
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, argvOf, SKILL_ROOT } from './lib/paths.mjs';
import { readTrace, summarizeTrace, traceFile } from './lib/trace.mjs';
import { renderDaily } from './lib/daily-report.mjs';

const { argOf } = argvOf(process.argv.slice(2).map((a) => a.replace(/^--/, '')));
const config = await loadConfig();
const dateStr = argOf('date', '');
const when = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
if (dateStr && Number.isNaN(when.getTime())) {
  console.error(`[日报] --date 格式应为 YYYY-MM-DD，收到：${dateStr}`);
  process.exit(2);
}
const rows = readTrace(config, when);
const summary = summarizeTrace(rows);
// P4-e：把当日 LLM 调用数一并写进日报
let llmUsage = null;
try {
  const { llmUsageCount } = await import('./lib/llm.mjs');
  llmUsage = llmUsageCount();
} catch {}
const p = (n) => String(n).padStart(2, '0');
const ymd = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}`;
const md = renderDaily({ summary, rows, date: ymd, config, llmUsage });
const out = argOf('out', resolve(SKILL_ROOT, 'reports', `daily-${ymd}.md`));
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, md);
console.log(`[日报] trace=${traceFile(config, when)}`);
console.log(`[日报] 条数=${summary.total} 发送=${summary.sent} 弃答=${summary.abstain} 忠实失败=${summary.faithFail} 渠道失败=${summary.channelFail} 平均生成=${summary.avgGenMs ?? '-'}ms`);
console.log(`[日报] → ${out}`);