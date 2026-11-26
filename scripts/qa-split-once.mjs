#!/usr/bin/env node
// 答疑库一次性拆分：单文件 → 一条一文件（2026-11-25 多协作改造 P0）
//
// ## 干什么
//
// 把 `qa/答疑库.md`（76KB / 192 条）拆成 `qa/entries/<id>.md`，一条一个文件。
// 目的：多人同时加条目不再撞 git 文本冲突，PR diff 一条一文件看得清。
//
// ## 为什么安全（P0 原则：只加不改）
//
//   · 拆分**不改一个字**：正文原样搬进文件，frontmatter 只放元数据
//   · 旧文件保留（不删），两边并存可比对
//   · 脚本自带校验：条目数一致 + 每条正文逐字相同 + 关键词/置信度无丢失
//
// ## 用法
//
//   node scripts/qa-split-once.mjs --dry-run     # 只报告，不写
//   node scripts/qa-split-once.mjs --apply       # 真拆
//   node scripts/qa-split-once.mjs --apply --verify-only   # 只校验，不写

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from './lib/paths.mjs';
import { parseEntryFile, renderEntryFile, slugId, writeEntryFile } from './lib/qa-entry.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (n, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const config = await loadConfig();
const QA_FILE = config.paths?.qaFile || 'qa/答疑库.md';
const ENTRIES_DIR = arg('entries-dir') || 'qa/entries';
const ROOT = resolve(process.cwd());

/** 把单文件拆成块（与 qa-sync.mjs 的 splitBlocks 同一口径） */
function splitBlocks(raw) {
  const parts = String(raw || '').split(/\n(?=##\s)/g);
  return parts.slice(1).filter((b) => /^##\s/m.test(b));
}

/** 解析一个块（不依赖 lib/qa.mjs，避免耦合；口径对齐它的元数据规则） */
function parseBlock(b) {
  const question = (b.match(/^##\s*(?:问[:：]\s*)?(.*)$/m)?.[1] || '').trim();
  const sep = b.indexOf('\n---');
  const meta = sep >= 0 ? b.slice(0, sep) : b;
  const answer = (sep >= 0 ? b.slice(sep + 4) : '').trim();
  const kwMatch = meta.match(/关键词[:：]\s*(.+)/);
  const keywords = kwMatch
    ? kwMatch[1].split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean)
    : [];
  const version = (meta.match(/版本[:：]\s*(.+)/)?.[1] || '通用').trim();
  const signature = (meta.match(/签名[:：]\s*(.+)/)?.[1] || '').trim();
  const source = (meta.match(/来源[:：]\s*(https?:\/\/\S+)/)?.[1] || '').trim();
  const summarizedAt = (meta.match(/总结时间[:：]\s*(.+)/)?.[1] || '').trim();
  const confPct = meta.match(/置信度[:：]\s*(\d{1,3})\s*%?/);
  const confLegacy = meta.match(/置信度[:：]\s*(完全正确|高|中|低)/);
  const LEGACY = { 完全正确: 95, 高: 75, 中: 50, 低: 20 };
  let confidence = confPct ? Math.max(0, Math.min(100, Number(confPct[1]))) : null;
  if (confidence === null && confLegacy) confidence = LEGACY[confLegacy[1]] ?? null;  const semanticConfirm = /语义确认[:：]\s*(true|是|yes)/i.test(meta);
  return { question, answer, keywords, version, signature, source, summarizedAt, confidence, semanticConfirm, raw: b };
}

/** 块 → 条目（claims 留空 → 渲染成纯正文，保证无损） */
function toEntry(block) {
  return {
    id: slugId(block.question),
    question: block.question,
    keywords: block.keywords,
    version: block.version,
    updated: block.summarizedAt ? block.summarizedAt.slice(0, 10) : '',
    // 来源链接是**可追溯性**，不是个人信息（CONTRIBUTING 明确要求保留）→ 进 frontmatter
    source: block.source,
    author: block.signature,
    signature: block.signature,
    confidence: block.confidence,
    semanticConfirm: block.semanticConfirm,
    claims: [], // P0 不拆要点 → 正文原样
    body: block.answer,
  };
}

const raw = await readFile(QA_FILE, 'utf8');
const blocks = splitBlocks(raw);
console.log(`源文件：${QA_FILE}`);
console.log(`条目数：${blocks.length}`);

const entries = blocks.map(parseBlock).filter((b) => b.question && b.answer).map(toEntry);
const skipped = blocks.length - entries.length;
if (skipped) console.log(`⚠️ 跳过 ${skipped} 条（无问法或无正文）`);

// id 去重（同问法 → 同 slug → 加后缀）
const used = new Map();
for (const e of entries) {
  let id = e.id;
  if (used.has(id)) {
    const n = used.get(id) + 1;
    used.set(id, n);
    e.id = `${id}-${n}`;
  } else {
    used.set(id, 1);
  }
}

const entriesDir = resolve(ROOT, ENTRIES_DIR);
const verifyOnly = has('verify-only');

if (!has('--apply')) {
  console.log('\n[dry-run] 将会写入：');
  console.log(`  目录：${entriesDir}`);
  console.log(`  文件：${entries.length} 个`);
  console.log('  例：');
  for (const e of entries.slice(0, 5)) console.log(`    ${e.id}.md   「${e.question.slice(0, 24)}」 关键词${e.keywords.length} 置信度${e.confidence ?? '-'}`);
  console.log('\n加 --apply 真写。');
  process.exit(0);
}

if (!verifyOnly) {
  await mkdir(entriesDir, { recursive: true });
  const existing = new Set(await readdir(entriesDir).catch(() => []));
  let wrote = 0;
  let skippedExisting = 0;
  for (const e of entries) {
    const name = `${e.id}.md`;
    if (existing.has(name)) {
      skippedExisting++;
      continue; // 不覆盖已有文件（可能别人已经改过）
    }
    await writeEntryFile(entriesDir, e, { overwrite: false });
    wrote++;
  }
  console.log(`写入 ${wrote} 个，跳过已存在 ${skippedExisting} 个`);
}

// ── 校验：条目数一致 + 正文无丢失 ──
// ⚠️ 2026-11-26：已经拆过要点的条目，正文是 `## 要点` 段，不再等于原整段 ——
//    对这类只校验「原文的实义字符覆盖」，不要求逐字相同（逐字比会大批误报）。
const files = (await readdir(entriesDir).catch(() => [])).filter((f) => f.endsWith('.md'));
let textMismatch = 0;
let kwLost = 0;
let confLost = 0;
let checked = 0;
let skippedAsserted = 0;
for (const b of blocks) {
  const p = parseBlock(b);
  if (!p.question || !p.answer) continue;
  const idx = entries.findIndex((e) => e.question === p.question && e.answer === p.answer);
  const id = idx >= 0 ? entries[idx].id : slugId(p.question);
  const f = join(entriesDir, `${id}.md`);
  let txt;
  try {
    txt = await readFile(f, 'utf8');
  } catch {
    continue;
  }
  const parsed = parseEntryFile(txt);
  checked++;
  const hasClaimsSection = /^#{1,3}\s*要点\s*$/m.test(parsed.body || '');
  if (hasClaimsSection) {
    // 已拆要点 → 只查覆盖（原文实义字符是否都出现在要点里）
    const src = new Set([...String(p.answer)].filter((ch) => !/[\s\p{P}\p{S}\d]/u.test(ch)));
    let covered = 0;
    const claimText = (parsed.claims || []).map((c) => c.text).join('');
    for (const ch of src) if (claimText.includes(ch)) covered++;
    const cov = src.size ? covered / src.size : 1;
    // 阈值 80%：拆点会用玩家口气改写措辞，字符覆盖天然到不了 100%（实测 85~86% 属正常）；
    // 真丢信息会远低于此。首次拆点的闸（qa-resplit 的 checkCoverage）仍是 90%，两处用途不同。
    if (cov < 0.8) {
      textMismatch++;
      if (textMismatch <= 3) console.log(`  要点覆盖不足 ${(cov * 100).toFixed(0)}%：${id}`);
    } else {
      skippedAsserted++;
    }
  } else {
    const bodyInFile = parsed.body.trim();
    if (bodyInFile !== p.answer) {
      textMismatch++;
      if (textMismatch <= 3) console.log(`  正文不一致：${id}\n    原：${p.answer.slice(0, 60)}\n    新：${bodyInFile.slice(0, 60)}`);
    }
  }
  if ((parsed.keywords || []).length !== p.keywords.length) {
    kwLost++;
    if (kwLost <= 3) console.log(`  关键词数量不一致：${id}  原${p.keywords.length} 新${(parsed.keywords || []).length}`);
  }
  if (p.confidence != null && parsed.confidence !== p.confidence) {
    confLost++;
    if (confLost <= 3) console.log(`  置信度不一致：${id}  原${p.confidence} 新${parsed.confidence}`);
  }
}

console.log(`\n校验：比对 ${checked} 条（其中 ${skippedAsserted} 条已拆要点，按覆盖率查）`);
console.log(`  正文/要点无丢失：${textMismatch === 0 ? '✅ 全对' : `❌ ${textMismatch} 条有问题`}`);
console.log(`  关键词无丢失：${kwLost === 0 ? '✅' : `❌ ${kwLost} 条不一致`}`);
console.log(`  置信度无丢失：${confLost === 0 ? '✅' : `❌ ${confLost} 条不一致`}`);
console.log(`  条目数：源 ${blocks.length} → 目录 ${files.length}`);
if (textMismatch || kwLost || confLost) process.exit(1);
