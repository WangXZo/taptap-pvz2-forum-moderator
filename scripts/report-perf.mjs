#!/usr/bin/env node
// 耗时分布报告（2026-11-20 · T20）
//
//   node scripts/report-perf.mjs              # 近 1 天
//   node scripts/report-perf.mjs --days 7     # 近 7 天
//   node scripts/report-perf.mjs --out x.md
//
// 数据来源：reports/trace-<date>.jsonl 里 event=phase 的行（打点从 2026-11-20 起生效）。

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, argvOf } from './lib/paths.mjs';
import { readTrace } from './lib/trace.mjs';
import { summarizePerf, renderPerf } from './lib/perf.mjs';

const { argOf } = argvOf(process.argv.slice(2).map((a) => a.replace(/^--/, '')));
const config = await loadConfig();
const days = Math.max(1, Number(argOf('days', 1)));

const rows = [];
const dates = [];
for (let i = 0; i < days; i++) {
  const d = new Date(Date.now() - i * 86400000);
  const dayRows = readTrace(config, d);
  rows.push(...dayRows);
  const p = (n) => String(n).padStart(2, '0');
  dates.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
}
const summary = summarizePerf(rows);
const label = days === 1 ? dates[0] : `${dates[dates.length - 1]} ~ ${dates[0]}`;
const md = renderPerf(summary, { date: label, config });

const out = resolve(argOf('out', resolve(config.paths.reportsDir, `perf-${dates[0]}.md`)));
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, md, 'utf8');

console.log(`[耗时] ${label}｜样本 ${summary.samples}${summary.perPostMs ? `｜平均每帖 ${summary.perPostMs} ms` : ''}`);
if (summary.samples) {
  for (const [k, v] of Object.entries(summary.byPhase)) {
    console.log(`  ${k.padEnd(16)} ${String(v.count).padStart(4)} 次  平均 ${String(v.avg).padStart(6)} ms  p90 ${String(v.p90).padStart(6)} ms`);
  }
} else {
  console.log('  （无 phase 打点记录。打点从 2026-11-20 起生效，之前跑的守护不会产生这类数据）');
}
console.log(`[耗时] → ${out}`);