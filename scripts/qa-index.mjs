#!/usr/bin/env node
// 答疑库向量索引：建库 / 查询 / 看状态
//
// 用法：
//   node scripts/qa-index.mjs build          # 重建索引（答疑库改了之后跑一次）
//   node scripts/qa-index.mjs stats          # 看索引状态
//   node scripts/qa-index.mjs query "无尽卡波" # 试检索（看召回对不对）
//   node scripts/qa-index.mjs query "xxx" --dense   # 用配置的 dense 后端试（没配就退回 char-tfidf）
//
// 索引存在 data/qa-index.sqlite（和答疑库正文分开，改库不影响索引）

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/paths.mjs';
import { loadQaLibrary } from './lib/qa.mjs';
import { openDb, stats } from './lib/db.mjs';
import { buildIndex, search, makeHttpDense } from './lib/qa-vector.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const argv = process.argv.slice(2);
const cmd = argv[0] || 'stats';
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const config = await loadConfig();
const qaFile = config.paths?.qaFile || resolve(ROOT, 'qa/答疑库.md');
const dbFile = config.paths?.qaIndexFile || resolve(ROOT, 'data/qa-index.sqlite');

const db = openDb(dbFile);
const entries = await loadQaLibrary(qaFile);

if (cmd === 'build') {
  const r = buildIndex(db, entries);
  console.log(`已建索引：${r.entries} 条答疑 / ${r.tokens} 个特征词 → ${dbFile}`);
  const s = stats(db);
  console.log(`  qa_vec 行数：${s.byStatus ? '' : ''}${Object.keys(s.byStatus).length ? '' : ''}${(await import('./lib/db.mjs')).loadVectors(db).length}`);
  process.exit(0);
}

if (cmd === 'stats') {
  const { loadVectors } = await import('./lib/db.mjs');
  const rows = loadVectors(db);
  console.log(`索引文件：${dbFile}`);
  console.log(`答疑条目：${entries.length} 条（源：${qaFile}）`);
  console.log(`已建向量：${rows.length} 条`);
  const vecs = await import('./lib/qa-vector.mjs');
  const corpus = vecs.loadCorpus(db);
  console.log(`特征词：${corpus.df.size} 个`);
  for (const r of rows.slice(0, 8)) {
    console.log(`  ${r.entry_id}  ${String(r.question).slice(0, 26)}  dim=${Object.keys(JSON.parse(r.vec)).length}`);
  }
  process.exit(0);
}

if (cmd === 'query') {
  const q = argv.slice(1).filter((a) => !a.startsWith('--'))[0];
  if (!q) {
    console.error('用法：node scripts/qa-index.mjs query "问题"');
    process.exit(1);
  }
  let dense = null;
  if (argv.includes('--dense')) {
    const v = config.qa?.vector || {};
    dense = makeHttpDense({ endpoint: v.endpoint, model: v.model, apiKey: v.apiKey || '' });
    if (!dense) console.log('（没配 qa.vector.endpoint/model → 退回 char-tfidf）');
  }
  const r = await search(db, q, { topN: 5, dense });
  console.log(`查询：${q}`);
  console.log(`路径：${r.path}`);
  if (!r.results.length) console.log('（无召回）');
  for (const x of r.results) {
    const e = entries.find((e) => e.id === x.entryId);
    console.log(`  ${x.score.toFixed(3)}  ${e ? e.question : x.entryId}`);
  }
  process.exit(0);
}

console.log('用法：node scripts/qa-index.mjs build|stats|query "..."');
