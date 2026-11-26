// 路径与配置解析：所有脚本共用
// skill 根 = 本文件上溯两级（lib/ -> scripts/ -> skill 根）
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCRIPTS_DIR = resolve(SKILL_ROOT, 'scripts');

/**
 * 路径展开规则
 *   {{SKILL}}  → skill 根目录（跟随 skill 移动，分享给别人不用改配置）
 *   ~/xxx      → 用户主目录
 *   其它       → 相对当前工作目录
 */
export function expand(p) {
  if (!p) return p;
  let s = String(p).trim();
  if (s.includes('{{SKILL}}')) {
    s = s.replace(/\{\{SKILL\}\}/g, SKILL_ROOT);
  }
  if (s === '~') s = homedir();
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = resolve(homedir(), s.slice(2));
  return resolve(s);
}

/**
 * 读配置
 *
 * 2026-11-20（阶段 3）：加载后统一走 lib/config.mjs 的 resolveConfig ——
 *   ① 旧键迁移（features.* / plugins.* → 各功能自己的 enabled，双写保留旧键）
 *   ② 按 scripts/config/schema.json 补默认值（**只补缺失，绝不覆盖已写**）
 *   ③ 环境变量覆盖 TAPTAP_CFG_<GROUP>_<FIELD>
 *   ④ 类型/范围校验（只警告，不中断 —— 守护不能因为一个配置项写错就停）
 *
 * @param {string} [file]
 * @param {object} [o]
 * @param {Function} [o.log] 给了才打印迁移/校验摘要；不给静默（避免刷守护日志）
 */
export async function loadConfig(file, { log = null } = {}) {
  const f = file || resolve(SCRIPTS_DIR, 'config.json');
  let cfg = JSON.parse(await readFile(f, 'utf8'));
  const { resolveConfig, deepMerge } = await import('./config.mjs');

  // ① config.local.json：个人覆盖（不入库），深合并进去再统一解析
  let localFile = null;
  try {
    const lf = resolve(dirname(f), 'config.local.json');
    cfg = deepMerge(cfg, JSON.parse(await readFile(lf, 'utf8')));
    localFile = lf;
  } catch {
    /* 没有 config.local.json 是常态 */
  }

  // ② 迁移 + 补默认 + env 覆盖 + 校验
  cfg = resolveConfig(cfg, { log });
  cfg.__configFile = f;
  if (localFile) cfg.__configLocal = localFile;

  for (const k of Object.keys(cfg.paths || {})) {
    cfg.paths[k] = expand(cfg.paths[k]);
  }
  // 目录缺失时自动建（首次运行即自包含，无需手工准备）
  const { mkdir } = await import('node:fs/promises');
  for (const k of ['dataDir', 'reportsDir']) {
    if (cfg.paths[k]) await mkdir(cfg.paths[k], { recursive: true });
  }
  await mkdir(dirname(cfg.paths.stateFile), { recursive: true });
  await mkdir(dirname(cfg.paths.qaFile), { recursive: true });
  return cfg;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 条目目录（一条一文件形态）· 2026-11-25
 *
 * 从 qaFile 推导：`<...>/qa/答疑库.md` → `<...>/qa/entries`
 * 这样所有 loadQaLibrary 调用点**零改动**就能切到新形态。
 *
 * @param {string} qaFile
 * @returns {string} 条目目录绝对路径
 */
export function qaEntriesDirOf(qaFile) {
  const f = String(qaFile || '');
  if (!f) return '';
  return resolve(dirname(f), 'entries');
}

/** 同义别名（summarize/qa-admin 等处用） */
export const pathOfEntriesDir = qaEntriesDirOf;

export const argvOf = (argv) => {
  const has = (f) => argv.includes(f);
  const argOf = (n, d) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  return { has, argOf };
};
