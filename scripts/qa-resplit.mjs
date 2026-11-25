#!/usr/bin/env node
// 存量条目批量拆要点（2026-11-25 多协作改造 P4 收尾）
//
// ## 为什么需要
//
// 拆分迁移（P0）把 193 条拆成一条一文件，但**每条还是一整段正文**（无损优先）。
// 而合并是**要点级**的 —— 新提交的要点要和存量条目的要点对齐，才能聚合成更高置信度。
// 所以存量也得有要点。
//
// ## 安全设计
//
//   · **覆盖率闸**：LLM 拆点可能漏内容。拆完校验「要点覆盖原文的实义字符 ≥90%」，
//     不达标就**保留整段当一个要点**（宁可粗，不可丢 —— 答案会被自动发给玩家）
//   · **原文不丢**：要点段之外保留原正文（`## 原文`），正文即事实备份
//   · **可中断可续跑**：已拆过的跳过（看有没有要点段）
//   · **失败不阻塞**：LLM 挂了就跳过这条，继续下一条
//
// ## 用法
//
//   node scripts/qa-resplit.mjs --dry-run            # 只报告，不调 LLM
//   node scripts/qa-resplit.mjs --apply              # 真拆（会调 LLM）
//   node scripts/qa-resplit.mjs --apply --limit 20   # 只拆前 20 条（试水）
//   node scripts/qa-resplit.mjs --apply --min-len 40 # 只拆答案 ≥40 字的

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig, expand } from './lib/paths.mjs';
import { parseEntryFile, renderEntryFile, plainTextOf } from './lib/qa-entry.mjs';
import { splitClaims, seedClaimConfidence, checkCoverage } from './lib/qa-split.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (n, d = 0) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? Number(argv[i + 1]) : d;
};

const config = await loadConfig();
const DIR = resolve(expand(config.collab?.entriesDir || '{{SKILL}}/qa/entries'));
const LIMIT = arg('limit', 0);
const MIN_LEN = arg('min-len', 24);
const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x90m', b: '\x1b[1m', x: '\x1b[0m' };

const files = (await readdir(DIR).catch(() => [])).filter((f) => f.endsWith('.md'));
const todo = [];
for (const f of files) {
  const raw = await readFile(join(DIR, f), 'utf8');
  const e = parseEntryFile(raw);
  if (/^#{1,3}\s*要点\s*$/m.test(raw)) continue; // 已拆过
  const text = plainTextOf(e);
  if (text.length < MIN_LEN) continue; // 太短，本来就是一个点
  todo.push({ file: f, entry: e, text });
}

console.log(`条目 ${files.length} 个 · 待拆 ${todo.length} 个（答案 ≥${MIN_LEN} 字）`);
if (!has('--apply')) {
  console.log('\n[dry-run] 前 8 条：');
  for (const t of todo.slice(0, 8)) console.log(`  ${t.file}  ${t.text.length} 字  「${t.text.slice(0, 40)}」`);
  console.log('\n加 --apply 真拆（会调 LLM）。');
  process.exit(0);
}

let done = 0;
let skipped = 0;
let failed = 0;
let lowCov = 0;
const t0 = Date.now();

for (const t of todo.slice(0, LIMIT || todo.length)) {
  const r = await splitClaims({
    answer: t.text,
    question: t.entry.question,
    config: config.llm || {},
    log: () => {},
  });
  if (r.method === 'llm-failed' || r.method === 'llm-empty') {
    failed++;
    process.stdout.write(`  ${C.r}✗${C.x} ${t.file}（${r.method}）\n`);
    continue;
  }
  if (r.method === 'low-coverage') {
    lowCov++;
    process.stdout.write(`  ${C.y}~${C.x} ${t.file}（覆盖不足 → 保留整段）\n`);
    continue;
  }
  const claims = seedClaimConfidence(r.claims, { source: t.entry.source || null, manual: !t.entry.source });
  // 来源挂到每条要点上（来源链接是整条条目的出处）
  const srcs = t.entry.source ? [t.entry.source] : [];
  const entry = {
    ...t.entry,
    claims: claims.map((c) => ({ ...c, sources: srcs.length ? [...srcs] : [] })),
    confidence: Math.max(...claims.map((c) => c.confidence || 0)),
    updated: new Date().toISOString().slice(0, 10),
  };
  await writeFile(join(DIR, t.file), renderEntryFile(entry), 'utf8');
  done++;
  const cov = r.coverage != null ? ` 覆盖${(r.coverage * 100).toFixed(0)}%` : '';
  process.stdout.write(`  ${C.g}✓${C.x} ${t.file} → ${claims.length} 点${cov}\n`);
}

const secs = Math.round((Date.now() - t0) / 1000);
console.log(`\n拆完 ${done} 条 · 保留整段 ${lowCov} 条 · 失败 ${failed} 条 · 跳过 ${skipped} 条（${secs}s）`);
