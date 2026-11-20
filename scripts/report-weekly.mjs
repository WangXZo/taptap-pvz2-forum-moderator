#!/usr/bin/env node
// P4-c 周报 CLI（2026-11-19）：手动生成周报
//   node scripts/report-weekly.mjs              # 近 7 天
//   node scripts/report-weekly.mjs --days 14
//   node scripts/report-weekly.mjs --out <file>
import { resolve } from 'node:path';
import { loadConfig, argvOf } from './lib/paths.mjs';
import { loadUsage } from './lib/usage.mjs';
import { default as weeklyPlugin } from './plugins/weekly.mjs';

const { argOf } = argvOf(process.argv.slice(2).map((a) => a.replace(/^--/, '')));
const config = await loadConfig();
const usage = await loadUsage(config.paths.usageFile);
const days = Number(argOf('days', 7));
const r = await weeklyPlugin.build({ config, log: console.log, usage, days });
console.log(`[周报] ${r.from} ~ ${r.to}｜发送 ${r.sent}｜弃答 ${r.abstain}`);
console.log(`[周报] → ${r.out}`);