#!/usr/bin/env node
// 答疑库双向合并：仓库副本 ⇄ 运行中副本
//
// ## 为什么需要它
//
// 协作场景下，答疑库有**两个副本**，各自都会被写：
//
//   仓库副本  output/repo/qa/答疑库.md   ← 人通过 PR 补问答（人工内容为主）
//   运行中副本 ~/.dsh/skills/.../qa/答疑库.md ← 守护进程自动沉淀（社区内容为主）
//
//   两者会**同时增长**，直接覆盖必然丢东西。
//   历史教训：曾用构建源的旧副本覆盖运行中的答疑库，一夜之间自动沉淀的 10 条全丢。
//
// ## 合并规则（按「来源链接」判定身份，不靠行号）
//
//   · 一条条目的身份 = 它的 `- 来源：` 链接（人工条目可能没有来源 → 用问法当身份）
//   · 只在一边有 → 直接带过去
//   · 两边都有但正文不同 → **以「运行中」为准**（它是被守护进程验证过的），并打印差异提醒
//   · 人工条目（无来源）→ 两边同名同问法时保留更长的那个正文（通常是补全过的那份）
//
// ## 用法
//
//   node scripts/qa-sync.mjs --status        # 只看差异，不写
//   node scripts/qa-sync.mjs --to-repo        # 运行中 → 仓库（把自动沉淀带上去）
//   node scripts/qa-sync.mjs --to-runtime     # 仓库 → 运行中（把 PR 的新问答带下来）
//   node scripts/qa-sync.mjs --to-repo --apply  真正写入（默认只预演）
//
// 仓库副本路径：默认取本文件上溯两级的 qa/答疑库.md
// 运行中副本路径：默认取 config.json 的 paths.qaFile

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, SKILL_ROOT } from './lib/paths.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (n, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };

/**
 * 仓库副本路径
 *   优先 --repo-qa；否则取 git 仓库根下的 qa/答疑库.md；
 *   都不是就用 skill 自己的（= 从仓库直接跑时的情况）
 */
function repoQaPath() {
  if (arg('repo-qa')) return resolve(arg('repo-qa'));
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: SKILL_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (top) return join(top, 'qa', '答疑库.md');
  } catch {
    /* 不在 git 仓库里 */
  }
  return join(SKILL_ROOT, 'qa', '答疑库.md');
}

/** 运行中副本路径：--runtime-qa 或 config.paths.qaFile */
function runtimeQaPath(config) {
  if (arg('runtime-qa')) return resolve(arg('runtime-qa'));
  return config.paths.qaFile;
}

// ---------- 解析库文件 ----------
function splitBlocks(raw) {
  const parts = String(raw || '').split(/\n(?=##\s)/g);
  const header = parts[0] || '';
  const blocks = parts.slice(1).filter((b) => /^##\s/m.test(b));
  return { header, blocks };
}

function parseBlock(b) {
  const question = (b.match(/^##\s*(?:问：)?(.*)$/m)?.[1] || '').trim();
  const source = (b.match(/- 来源[:：]\s*(\S+)/)?.[1] || '').trim();
  const i = b.indexOf('\n---');
  const answer = (i >= 0 ? b.slice(i + 4) : '').trim();
  const keywords = (b.match(/- 关键词[:：]\s*(.*)/)?.[1] || '').trim();
  return { question, source, answer, keywords, raw: b.trim() };
}

/** 身份：有来源用来源，没有就用问法 */
const keyOf = (e) => e.source || `q:${e.question}`;

/**
 * 合并：base = 运行中，incoming = 仓库
 * 返回合并后的 blocks 数组
 */
function merge(baseEntries, incomingEntries) {
  const out = [];
  const byKey = new Map();
  for (const e of baseEntries) {
    byKey.set(keyOf(e), e);
    out.push(e);
  }
  const stats = { added: 0, same: 0, changed: 0, manual: 0 };

  for (const inc of incomingEntries) {
    const k = keyOf(inc);
    const cur = byKey.get(k);
    if (!cur) {
      out.push(inc);
      byKey.set(k, inc);
      stats.added++;
      continue;
    }
    if (cur.answer === inc.answer) {
      stats.same++;
      continue;
    }
    // 两边内容不同
    if (!cur.source && !inc.source) {
      // 都是人工条目：保留更长的正文（通常是补全过的那份），但保留当前的关键词
      if (inc.answer.length > cur.answer.length) {
        const merged = { ...inc, keywords: cur.keywords || inc.keywords };
        const idx = out.indexOf(cur);
        out[idx] = merged;
        byKey.set(k, merged);
        stats.manual++;
      } else {
        stats.changed++;
      }
      continue;
    }
    // 有来源的冲突 → 以运行中为准，但记录下来
    stats.changed++;
  }
  return { entries: out, stats };
}

function render(header, entries) {
  return (
    [String(header).trim(), '']
      .concat(entries.map((e) => e.raw))
      .join('\n\n')
      .replace(/\s*$/, '\n')
  );
}

// ---------- 主流程 ----------
const config = await loadConfig();
const repoQa = repoQaPath();
const runQa = runtimeQaPath(config);

if (resolve(repoQa) === resolve(runQa)) {
  console.log(`${C.b}答疑库同步${C.x}`);
  console.log(`${C.y}仓库副本与运行中副本是同一个文件（${repoQa}）。${C.x}`);
  console.log(`${C.d}当前就是仓库本体，没有需要合并的另一份。${C.x}`);
  console.log(`${C.d}要同步到别处请显式指定：--repo-qa <路径> / --runtime-qa <路径>${C.x}`);
  process.exit(0);
}

let repoRaw = '';
let runRaw = '';
try {
  repoRaw = await readFile(repoQa, 'utf8');
} catch {
  console.error(`读不到仓库副本：${repoQa}`);
  process.exit(1);
}
try {
  runRaw = await readFile(runQa, 'utf8');
} catch {
  console.error(`读不到运行中副本：${runQa}`);
  process.exit(1);
}

const R = splitBlocks(repoRaw);
const N = splitBlocks(runRaw);
const repoEntries = R.blocks.map(parseBlock);
const runEntries = N.blocks.map(parseBlock);

console.log(`${C.b}答疑库同步${C.x}`);
console.log(`${C.d}仓库   ${repoQa}${C.x}  ${repoEntries.length} 条`);
console.log(`${C.d}运行中 ${runQa}${C.x}  ${runEntries.length} 条`);

// 以「运行中」为基准，把仓库侧的增量合并进来 → 运行中侧结果
const toRuntime = merge(runEntries, repoEntries);
// 以「仓库」为基准，把运行中侧的增量合并进来 → 仓库侧结果
const toRepo = merge(repoEntries, runEntries);

console.log(`\n${C.b}差异${C.x}`);
console.log(`  运行中 相对 仓库：新增 ${toRuntime.stats.added} 条，正文不同 ${toRuntime.stats.changed} 条，人工条目取长 ${toRuntime.stats.manual} 条`);
console.log(`  仓库   相对 运行中：新增 ${toRepo.stats.added} 条，正文不同 ${toRepo.stats.changed} 条，人工条目取长 ${toRepo.stats.manual} 条`);

if (toRepo.stats.changed || toRuntime.stats.changed) {
  console.log(`\n${C.y}两边内容不同的条目（以「运行中」为准）：${C.x}`);
  const runByKey = new Map(runEntries.map((e) => [keyOf(e), e]));
  for (const inc of repoEntries) {
    const cur = runByKey.get(keyOf(inc));
    if (cur && cur.answer !== inc.answer) {
      console.log(`  ${C.y}《${inc.question.slice(0, 28)}》${C.x}`);
      console.log(`     运行中：${cur.answer.slice(0, 70).replace(/\n/g, ' ')}`);
      console.log(`     仓库：  ${inc.answer.slice(0, 70).replace(/\n/g, ' ')}`);
    }
  }
}

if (has('status')) {
  console.log(`\n${C.d}(--status：只看差异，没写任何文件)${C.x}`);
  process.exit(0);
}

const apply = has('apply');
const targets = [];
if (has('to-repo')) targets.push({ label: '仓库副本', file: repoQa, merged: toRepo, header: R.header });
if (has('to-runtime')) targets.push({ label: '运行中副本', file: runQa, merged: toRuntime, header: N.header });
if (!targets.length) {
  console.log(`\n${C.y}没指定方向。用法：--to-repo / --to-runtime（可同时用），加 --apply 才真正写入${C.x}`);
  process.exit(0);
}

for (const t of targets) {
  if (!apply) {
    console.log(`\n${C.y}[预演]${C.x} ${t.label} 将写入 ${t.file}（${t.merged.entries.length} 条）`);
    continue;
  }
  await mkdir(dirname(t.file), { recursive: true });
  await writeFile(t.file, render(t.header, t.merged.entries), 'utf8');
  console.log(`\n${C.g}✓${C.x} 已更新 ${t.label}：${t.file}（${t.merged.entries.length} 条）`);
}

if (!apply) console.log(`\n${C.y}预演结束。确认无误后加 --apply 真正写入。${C.x}`);
