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

export async function loadConfig(file) {
  const f = file || resolve(SCRIPTS_DIR, 'config.json');
  const cfg = JSON.parse(await readFile(f, 'utf8'));
  cfg.__configFile = f;
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

export const argvOf = (argv) => {
  const has = (f) => argv.includes(f);
  const argOf = (n, d) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  return { has, argOf };
};
