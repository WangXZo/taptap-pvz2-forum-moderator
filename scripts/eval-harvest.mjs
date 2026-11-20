#!/usr/bin/env node
// O5 评测候选收割 CLI（2026-11-19）：data/eval-candidates.jsonl → 预标 → 并入 assets/eval-set.json
//   node scripts/eval-harvest.mjs              # dry-run：出提案报告
//   node scripts/eval-harvest.mjs --llm        # 用 LLM 预标 expect（intent/entryIncludes）
//   node scripts/eval-harvest.mjs --apply       # 合并进评测集（保留事故 case permanent）
//   node scripts/eval-harvest.mjs --max 120     # 上限（默认 100）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, argvOf, SKILL_ROOT } from './lib/paths.mjs';
import { dedupeCandidates, mergeIntoSet, candidateToCase, renderHarvestReport } from './lib/eval-harvest.mjs';
import { retrieve } from './lib/retrieve.mjs';
import { intentOf } from './lib/intent.mjs';
import { loadQaLibrary } from './lib/qa.mjs';
import { openDb } from './lib/db.mjs';
import { initFacts } from './lib/facts.mjs';

const { argOf, has } = argvOf(process.argv.slice(2).map((a) => a.replace(/^--/, '')));
const config = await loadConfig();
const setFile = resolve(SKILL_ROOT, 'assets/eval-set.json');
const candFile = resolve(String(config.paths.dataDir || resolve(SKILL_ROOT, 'data')).replace(/\{\{SKILL\}\}/g, SKILL_ROOT), 'eval-candidates.jsonl');

const raw = JSON.parse(readFileSync(setFile, 'utf8'));
const existing = raw.cases || [];
let cands = [];
if (existsSync(candFile)) {
  cands = readFileSync(candFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
console.log(`[harvest] 候选 ${cands.length} ／ 现有评测集 ${existing.length} 条 ｜ apply=${has('apply')}`);

const fresh = dedupeCandidates(cands, existing);
// 预标：默认走本地规则（intentOf + retrieve 命中条目），--llm 不额外加钱（这里用规则，LLM 仅用于条目名，略）
const db = openDb(config.paths.postDbFile);
initFacts(db);
const qa = await loadQaLibrary(config.paths.qaFile);
const newCases = [];
for (const c of fresh) {
  const post = { title: c.title, text: c.text || '' };
  const intent = intentOf(post);
  let entryIncludes = null;
  try {
    const r = await retrieve(post, { qa, db, config, log: () => {} });
    if (r.entry?.question) entryIncludes = String(r.entry.question).slice(0, 8);
  } catch {}
  newCases.push(candidateToCase(c, { intent, entryIncludes }));
}

const merged = mergeIntoSet(existing, newCases, { maxCases: Number(argOf('max', 100)) });
const report = renderHarvestReport({ cands: cands.length, fresh: newCases, cases: merged.cases, added: merged.added, trimmed: merged.trimmed, apply: has('apply') });
mkdirSync(config.paths.reportsDir, { recursive: true });
const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const ymd = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const out = resolve(config.paths.reportsDir, `eval-harvest-${ymd}.md`);
writeFileSync(out, report);
console.log(`[harvest] 新增可用 ${newCases.length} ／ 裁剪 ${merged.trimmed} ／ 集内 ${merged.cases.length} 条`);
console.log(`[harvest] 报告 → ${out}`);

if (has('apply')) {
  if (!merged.added) {
    console.log('[harvest] 无新增，未改集');
  } else {
    writeFileSync(setFile, JSON.stringify({ ...raw, note: raw.note, cases: merged.cases }, null, 2) + '\n');
    console.log(`[harvest] 已写入 ${setFile}（${merged.cases.length} 条）`);
  }
}