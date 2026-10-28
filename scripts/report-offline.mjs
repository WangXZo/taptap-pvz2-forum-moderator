#!/usr/bin/env node
// 离线重建报表：不联网，直接从状态库生成 questions.md / questions.csv
// 用法：node scripts/report-offline.mjs

import { loadConfig } from './lib/paths.mjs';
import { loadState } from './lib/state.mjs';
import { loadUsage } from './lib/usage.mjs';
import { loadQaLibrary } from './lib/qa.mjs';
import { renderReport } from './lib/report.mjs';

const config = await loadConfig();
const state = await loadState(config.paths.stateFile);
const usage = await loadUsage(config.paths.usageFile);
const qa = await loadQaLibrary(config.paths.qaFile).catch(() => []);

await renderReport({
  results: [],
  config,
  qa,
  root: config.paths.dataDir,
  state,
  usage,
});

console.log(`[离线报表] 已重建 ${Object.keys(state.posts).length} 条记录 → ${config.paths.reportsDir}`);
console.log(`[离线报表] 答疑库 ${qa.length} 条（社区沉淀 ${qa.filter((e) => e.auto).length} 条）`);
