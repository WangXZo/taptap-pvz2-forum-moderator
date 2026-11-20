#!/usr/bin/env node
// P4-c 评价分析 CLI（2026-11-19）：**只读分析，不回复评价**
//   node scripts/review-analyze.mjs                    # 用内置评价接口拉取（若可用）
//   node scripts/review-analyze.mjs --file items.json  # 用本地 JSON（[{score,text}]）
//
// 决策背景：评价对外公开、处置归人工（删评也归人工）→ 本工具只产出分析报告。
import { readFileSync, existsSync } from 'node:fs';
import { loadConfig, argvOf } from './lib/paths.mjs';
import { default as reviewPlugin } from './plugins/review.mjs';

const { argOf } = argvOf(process.argv.slice(2).map((a) => a.replace(/^--/, '')));
const config = await loadConfig();

let fetchReviews = null;
const file = argOf('file', '');
if (file) {
  if (!existsSync(file)) { console.error(`[评价] 文件不存在：${file}`); process.exit(2); }
  fetchReviews = async () => JSON.parse(readFileSync(file, 'utf8'));
} else {
  // 尝试用脚本自带的评价接口能力（存在才用；不存在就提示手动给文件，不擅自硬调接口）
  try {
    const mod = await import('./lib/review.mjs');
    if (typeof mod.fetchReviews === 'function') fetchReviews = mod.fetchReviews;
  } catch {}
}

if (!fetchReviews) {
  console.log('[评价] 未能自动取数（无内置评价接口能力）。');
  console.log('       → 用 --file items.json 传入 [{score, text}]，或先配置评价拉取能力。');
  process.exit(0);
}

const r = await reviewPlugin.scheduled({
  config: { ...config, review: { ...(config.review || {}), enabled: true } },
  log: console.log,
  fetchReviews,
});
if (r?.skipped) console.log(`[评价] 跳过：${r.skipped}`);
else if (r?.ok) console.log(`[评价] 分析 ${r.total} 条（低分 ${r.lowCount}）→ ${r.out}（未回复任何评价）`);