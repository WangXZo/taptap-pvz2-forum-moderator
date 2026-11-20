#!/usr/bin/env node
// C9 评测 CLI（P3，2026-11-18）：
//   node scripts/eval.mjs                 # 规则模式（零 LLM）：路由/静默/检索召回
//   node scripts/eval.mjs --llm           # 加 LLM：分档/生成/口吻/忠实度
//   node scripts/eval.mjs --dense char    # AB：换 dense 路对比召回
//   node scripts/eval.mjs --rerank llm    # AB：换 rerank backend
//   node scripts/eval.mjs --save-baseline # 存基线 data/eval-baseline.json（之后自动对比）
//   node scripts/eval.mjs --set <file> --out <file>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, argvOf, SKILL_ROOT } from './lib/paths.mjs';
import { loadQaLibrary } from './lib/qa.mjs';
import { openDb } from './lib/db.mjs';
import { initFacts } from './lib/facts.mjs';
import { runEval, renderReport } from './lib/eval.mjs';

// argvOf 约定裸参数名；CLI 习惯 --xx → 入口统一剥掉前缀（不动 argvOf，免影响其它脚本）
const { argOf, has } = argvOf(process.argv.slice(2).map((a) => a.replace(/^--/, '')));
const config = await loadConfig();
if (argOf('dense')) config.retrieve = { ...(config.retrieve || {}), denseBackend: argOf('dense') };
if (argOf('rerank')) config.rerank = { ...(config.rerank || {}), backend: argOf('rerank') };
const setFile = argOf('set', resolve(SKILL_ROOT, 'assets/eval-set.json'));
const raw = JSON.parse(readFileSync(setFile, 'utf8'));
const set = raw.cases || raw;
const qa = await loadQaLibrary(config.paths.qaFile);
const db = openDb(config.paths.postDbFile);
initFacts(db); // 新库/镜像库可能没 facts 表（collect 每轮 govern 会补，评测自立补齐）
const llm = has('llm');
console.log(`[eval] ${set.length} cases ｜ llm=${llm} ｜ dense=${config.retrieve?.denseBackend} ｜ rerank=${config.rerank?.backend}`);
const res = await runEval({ config, qa, db, set, llm, log: console.log });
const md = renderReport(res, { mode: llm ? 'llm' : 'rule', config });
mkdirSync(config.paths.reportsDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = argOf('out', resolve(config.paths.reportsDir, `eval-${ts}.md`));
writeFileSync(out, md);
writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify(res, null, 2));
console.log(md.split('\n').slice(0, 16).join('\n'));
console.log(`[eval] 报告 → ${out}`);
const baseFile = resolve(SKILL_ROOT, 'data/eval-baseline.json');
if (has('save-baseline')) {
  mkdirSync(resolve(SKILL_ROOT, 'data'), { recursive: true });
  writeFileSync(baseFile, JSON.stringify({ at: new Date().toISOString(), mode: llm ? 'llm' : 'rule', metrics: res.metrics }, null, 2));
  console.log('[eval] 基线已存');
} else {
  try {
    const base = JSON.parse(readFileSync(baseFile, 'utf8'));
    const diffs = Object.keys(res.metrics).filter((k) => base.metrics?.[k] != null && res.metrics[k] != null && base.metrics[k] !== res.metrics[k]);
    console.log(diffs.length ? `[eval] 与基线(${base.at})差异：${diffs.map((k) => `${k} ${base.metrics[k]}→${res.metrics[k]}`).join('，')}` : '[eval] 与基线无差异');
  } catch {}
}
const bad = res.cases.filter((c) => [c.routeOk, c.skipOk, c.sourceOk, c.recall5, c.tierOk, c.toneOk, c.faithOk].some((v) => v === false));
if (bad.length) console.log(`[eval] 未达标 ${bad.length}：${bad.map((c) => c.id).join('，')}`);