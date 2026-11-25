#!/usr/bin/env node
// 答疑库 N 路合并（2026-11-25 多协作改造 P4.5）
//
// ## 合并哪几路
//
//   ① GitHub main         别人合过的
//   ② GitHub contrib/*    各人免 PR 直提的分支
//   ③ 本地运行副本        守护进程自动沉淀
//   ④ 本地真源            手上正在改的
//
// ## 写回哪些地方
//
//   config.collab.merge.writeBack：github-main / local-runtime / local-src
//
// ## 每日定时：窗口内随机时刻 + 幂等锁
//
//   config.collab.merge.window = {start:'02:00', end:'05:00'}（本地时间，每个提交者自定）
//   每天在窗口内随机定一个时刻执行；锁文件记录当日时刻与执行状态 → 一天只跑一次。
//   目的是**避开多人同时拉取/提交**（撞 API 限流、撞分支、撞同一文件）。
//
// ## 用法
//
//   node scripts/qa-merge.mjs --status          # 只看各路差异，不写
//   node scripts/qa-merge.mjs --dry-run         # 出合并计划（默认）
//   node scripts/qa-merge.mjs --apply           # 真合并并写回
//   node scripts/qa-merge.mjs --apply --now     # 忽略随机时刻，立即执行（手动补跑）
//   node scripts/qa-merge.mjs --schedule        # 调度模式：到点才跑（供 cron/计划任务调用）

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { loadConfig, expand } from './lib/paths.mjs';
import { readAllEntries, parseEntryFile, renderEntryFile, writeEntryFile } from './lib/qa-entry.mjs';
import { mergeMany } from './lib/qa-merge.mjs';
import { createRemotes } from './lib/qa-github.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (n, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const config = await loadConfig();
const collab = config.collab || {};
const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x90m', b: '\x1b[1m', x: '\x1b[0m' };
const log = (m) => console.log(m);

// ── 路径 ──
const ENTRIES_DIR = expand(collab.entriesDir || '{{SKILL}}/qa/entries');
const QA_FILE = config.paths.qaFile;
const LOCK_FILE = expand(collab.merge?.lockFile || '{{SKILL}}/data/merge-lock.json');
const REMOTE = config.paths.remoteRepo; // 不存在也没关系
const SRC_ENTRIES = arg('src-dir') || ''; // 可选：本地真源条目目录

// ── 时间窗口与随机时刻 ──

/** 解析 'HH:MM' → 当天分钟数 */
function parseHm(s, fallback) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return fallback;
  return h * 60 + min;
}

/** 当天日期字符串（本地时区） */
function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 今天的随机时刻：窗口 [start,end] 内取一个（分钟粒度）
 * ⚠️ 同一天必须**稳定**（不能每次调用都重掷），所以由锁文件记住。
 */
function scheduledMinutes(dateStr, window, lock) {
  const start = parseHm(window?.start, 2 * 60);
  const end = parseHm(window?.end, 5 * 60);
  const span = Math.max(1, end - start);
  if (lock?.date === dateStr && Number.isFinite(lock?.scheduledMinute)) return lock.scheduledMinute;
  // 用日期做种子 → 同一天同机器算出同一个值（不依赖外部随机源，跨进程也一致）
  let h = 0;
  for (const ch of dateStr) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return start + (h % span);
}

async function readLock() {
  try {
    return JSON.parse(await readFile(LOCK_FILE, 'utf8'));
  } catch {
    return null;
  }
}
async function writeLock(lock) {
  await mkdir(dirname(LOCK_FILE), { recursive: true });
  await writeFile(LOCK_FILE, JSON.stringify(lock, null, 2), 'utf8');
}

// ── 各路来源 ──

async function loadLocalEntries(dir) {
  if (!dir) return [];
  try {
    return await readAllEntries(dir);
  } catch {
    return [];
  }
}

/** 读远端某分支的条目 */
async function loadRemoteEntries(remote, branch, prefix = 'qa/entries/') {
  const list = await remote.listEntries(branch, { prefix });
  const out = [];
  for (const f of list) {
    const r = await remote.readEntry(f.path, branch);
    if (!r?.content) continue;
    try {
      const e = parseEntryFile(r.content);
      e.__path = f.path;
      e.__sha = r.sha;
      out.push(e);
    } catch {
      /* 坏条目跳过 */
    }
  }
  return out;
}

// ── 主流程 ──

async function collectSources(remote) {
  const sources = [];
  // ① GitHub main
  if (remote?.available) {
    const mainEntries = await loadRemoteEntries(remote, remote.defaultBranch);
    sources.push({ origin: `github:${remote.defaultBranch}`, entries: mainEntries });
    // ② GitHub contrib/*
    const prefix = collab.merge?.contribPrefix || 'contrib/';
    const branches = await remote.listBranches(prefix);
    for (const b of branches) {
      const es = await loadRemoteEntries(remote, b);
      if (es.length) sources.push({ origin: `github:${b}`, entries: es });
    }
  }
  // ③ 本地运行副本
  const runtimeDir = arg('runtime-dir') || ENTRIES_DIR;
  sources.push({ origin: 'local-runtime', entries: await loadLocalEntries(runtimeDir) });
  // ④ 本地真源（可选）
  if (SRC_ENTRIES) sources.push({ origin: 'local-src', entries: await loadLocalEntries(SRC_ENTRIES) });
  return sources;
}

/** 合并结果 → 按 id 分组，供写回 */
function groupById(entries) {
  const map = new Map();
  for (const e of entries) {
    const id = e.id || e.question;
    map.set(id, e);
  }
  return map;
}

async function writeBackLocal(dir, entries) {
  await mkdir(dir, { recursive: true });
  const existing = new Set(await readdir(dir).catch(() => []));
  let wrote = 0;
  let updated = 0;
  for (const e of entries) {
    const name = `${e.id}.md`;
    if (existing.has(name)) {
      const cur = parseEntryFile(await readFile(join(dir, name), 'utf8'));
      if (renderEntryFile(cur) === renderEntryFile(e)) continue;
      await writeEntryFile(dir, e, { overwrite: true });
      updated++;
    } else {
      await writeEntryFile(dir, e, { overwrite: false });
      wrote++;
    }
  }
  return { wrote, updated };
}

async function writeBackRemote(remote, entries) {
  const prefix = 'qa/entries/';
  let wrote = 0;
  let updated = 0;
  let skipped = 0;
  const current = new Map((await remote.listEntries(remote.defaultBranch, { prefix })).map((f) => [f.path, f.sha]));
  for (const e of entries) {
    const path = `${prefix}${e.id}.md`;
    const content = renderEntryFile(e);
    const sha = current.get(path) || null;
    const r = await remote.writeEntry(path, content, { branch: remote.defaultBranch, sha, message: `chore(qa): 更新条目 ${e.id}` });
    if (r.ok) {
      if (sha) updated++;
      else wrote++;
    } else if (r.conflict) {
      skipped++; // 别人刚写过 → 跳过，下轮再合
    } else {
      skipped++;
    }
  }
  return { wrote, updated, skipped };
}

// ── 入口 ──

const dateStr = today();
const window = collab.merge?.window || { start: '02:00', end: '05:00' };
const lock = await readLock();
const schedMin = scheduledMinutes(dateStr, window, lock);
const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// 调度模式：没到点就退出（供 cron 每 15 分钟调一次）
if (has('--schedule')) {
  if (lock?.date === dateStr && lock?.ranAt) {
    log(`${C.d}[调度] 今天（${dateStr}）已执行过（${lock.ranAt}），跳过${C.x}`);
    process.exit(0);
  }
  if (nowMin < schedMin && !has('--now')) {
    log(`${C.d}[调度] 今日随机时刻 ${hhmm(schedMin)}（窗口 ${hhmm(parseHm(window.start, 120))}~${hhmm(parseHm(window.end, 300))}），还没到${C.x}`);
    process.exit(0);
  }
}

// 远端
const remotes = createRemotes(collab);
const remote = remotes[0] || null;
if (remote && !remote.available) log(`${C.y}远端不可用：${remote.reason}${C.x}`);

const sources = await collectSources(remote);
log(`${C.b}各路来源${C.x}`);
for (const s of sources) log(`  ${s.origin.padEnd(28)} ${s.entries.length} 条`);

// 合并
const merged = await mergeMany(sources, {});
const stats = merged.stats;
log(`\n${C.b}合并结果${C.x}`);
log(`  条目总数：${merged.entries.length}`);
log(`  新增：${stats.added}  合并要点：${stats.merged}  冲突：${merged.conflicts.length}`);

if (merged.conflicts.length) {
  log(`\n${C.y}冲突（需人复核）${C.x}`);
  for (const c of merged.conflicts.slice(0, 10)) {
    log(`  [${c.type}] ${c.entry || ''} ${c.origin || ''} ${c.detail || c.text || ''}`);
  }
}

if (has('--status')) {
  process.exit(0);
}

if (!has('--apply')) {
  log(`\n${C.d}[dry-run] 加 --apply 真写回${C.x}`);
  process.exit(0);
}

// ── 写回 ──
const targets = String(collab.merge?.writeBack || 'local-runtime').split(',').map((s) => s.trim()).filter(Boolean);
for (const t of targets) {
  try {
    if (t === 'github-main' && remote?.available) {
      const r = await writeBackRemote(remote, merged.entries);
      log(`写回 github-main：新增 ${r.wrote}，更新 ${r.updated}，跳过 ${r.skipped}`);
    } else if (t === 'local-runtime') {
      const r = await writeBackLocal(ENTRIES_DIR, merged.entries);
      log(`写回 local-runtime（${ENTRIES_DIR}）：新增 ${r.wrote}，更新 ${r.updated}`);
    } else if (t === 'local-src' && SRC_ENTRIES) {
      const r = await writeBackLocal(SRC_ENTRIES, merged.entries);
      log(`写回 local-src（${SRC_ENTRIES}）：新增 ${r.wrote}，更新 ${r.updated}`);
    }
  } catch (e) {
    log(`${C.r}写回 ${t} 失败：${e.message}${C.x}`);
  }
}

// 冲突报告
if (merged.conflicts.length) {
  const dir = expand(config.paths.archiveDir || '{{SKILL}}/qa/归档');
  await mkdir(dir, { recursive: true });
  const f = join(dir, `答疑库-合并冲突-${dateStr}.md`);
  const body = [
    `# 答疑库合并冲突 · ${dateStr}`,
    '',
    `> 合并时发现 ${merged.conflicts.length} 处冲突，未自动裁决，请人工复核。`,
    '',
    ...merged.conflicts.map((c) => `- **${c.type}** ${c.entry || ''}（来源：${c.origin || ''}）${c.detail || c.text || ''}`),
    '',
  ].join('\n');
  await writeFile(f, body, 'utf8');
  log(`冲突报告：${f}`);
}

// 锁
const newLock = { date: dateStr, scheduledMinute: schedMin, ranAt: new Date().toISOString(), stats };
await writeLock(newLock);
log(`\n${C.g}合并完成${C.x}（今日随机时刻 ${hhmm(schedMin)}，已记锁）`);
