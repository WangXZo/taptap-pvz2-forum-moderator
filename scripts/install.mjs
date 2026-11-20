#!/usr/bin/env node
// 一键安装：把环境准备好，让人能直接跑起来
//
// 用法：
//   node scripts/install.mjs                      # 交互式：只缺什么问什么
//   node scripts/install.mjs --my-user-id 12345   # 参数式：一次配好（给脚本/CI 用）
//   node scripts/install.mjs --dry-run            # 只看会做什么，不写文件
//
// 做什么：
//   ① 检查 Node / opencli / 浏览器扩展
//   ② 生成或补全 scripts/config.json（appId / groupId / 签名 / 自己的 user_id）
//   ③ 建好 data/ reports/ qa/归档 目录
//   ④ 跑一遍 doctor
//
// 不做什么：不装系统软件（opencli 请自己 npm i -g @jackwener/opencli）、不碰系统代理、不改注册表。

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { SKILL_ROOT, SCRIPTS_DIR } from './lib/paths.mjs';
import { resolveOpencliMain, makeRunner, doctorOk } from './lib/replier.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (n, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const dry = has('dry-run');

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
const say = (s = '') => console.log(s);

say(`${C.b}TapTap 论坛答疑助手 · 安装${C.x}`);
say(`${C.d}${SKILL_ROOT}${C.x}`);
if (dry) say(`${C.y}(dry-run：不会写任何文件)${C.x}`);

// ---------- ① 环境 ----------
say(`\n${C.b}1. 检查环境${C.x}`);
// Node 版本硬门槛：lib/db.mjs 用 `node:sqlite`，**Node ≥22.5** 才有。
// 以前 package.json 写 >=18，照着装会直接崩在第一次打开数据库（2026-11-20 修正）。
const [nMajor, nMinor] = String(process.versions.node).split('.').map(Number);
const nodeOk = nMajor > 22 || (nMajor === 22 && nMinor >= 5);
if (nodeOk) {
  say(`  ${C.g}✓${C.x} Node ${process.versions.node}`);
} else {
  say(`  ${C.r}✗${C.x} Node ${process.versions.node} 太老 —— 需要 **≥ 22.5**`);
  say(`      ${C.d}原因：内置 node:sqlite（lib/db.mjs）在 22.5 之前不存在${C.x}`);
  say(`      ${C.d}→ 去 https://nodejs.org 装 22.5+ 或 24.x，或 nvm install 24${C.x}`);
}

const opencliMain = resolveOpencliMain();
if (opencliMain) {
  say(`  ${C.g}✓${C.x} opencli ${C.d}${opencliMain}${C.x}`);
  const runner = makeRunner({ opencliMain, session: 'tap' });
  const d = doctorOk(runner);
  if (d.ok) say(`  ${C.g}✓${C.x} 浏览器扩展已连接`);
  else
    say(
      `  ${C.y}!${C.x} 浏览器扩展没连上\n` +
        `      → 打开 Chrome 并登录 TapTap，然后 opencli daemon restart`
    );
} else {
  say(`  ${C.r}✗${C.x} 没找到 opencli\n      → npm i -g @jackwener/opencli`);
}

// 官方 CLI（2026-11-20）：帖**全文**与**全部子回复**只能靠它拿
//   旧接口 summary 硬截 200 字、child_posts 只返 2 条 → 答偏、幂等盲判
{
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('taptap-cli', ['auth', 'status'], { encoding: 'utf8', timeout: 20000, shell: true });
  if (r?.error || r?.status !== 0) {
    say(`  ${C.y}!${C.x} 没找到 taptap-cli（读全文/全子回复会降级到旧接口）`);
    say(`      → npm i -g @taptap/cli && taptap-cli auth login`);
  } else {
    const txt = String(r.stdout || '');
    if (/Bearer:\s*有效|有效（/.test(txt)) {
      say(`  ${C.g}✓${C.x} taptap-cli 已登录`);
    } else {
      say(`  ${C.y}!${C.x} taptap-cli 已安装但未登录`);
      say(`      → taptap-cli auth login（扫码授权）`);
    }
  }
}

// ---------- ② 配置 ----------
say(`\n${C.b}2. 配置${C.x}`);
const cfgPath = join(SCRIPTS_DIR, 'config.json');
let cfg = {};
try {
  cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  say(`  ${C.d}已有 scripts/config.json${C.x}`);
} catch {
  say(`  ${C.y}!${C.x} 没有 config.json，将生成一份默认的`);
}

const changes = [];
const set = (path, value) => {
  if (value === undefined || value === null || value === '') return;
  const [a, b] = path.split('.');
  if (b) {
    cfg[a] = cfg[a] || {};
    if (cfg[a][b] !== value) changes.push(`${path}: ${cfg[a][b] ?? '(空)'} → ${value}`);
    cfg[a][b] = value;
  } else {
    if (cfg[a] !== value) changes.push(`${path}: ${cfg[a] ?? '(空)'} → ${value}`);
    cfg[a] = value;
  }
};

set('appId', arg('app-id'));
set('groupId', arg('group-id'));
set('myUserId', arg('my-user-id'));
set('reply.signature', arg('signature'));

// 没给参数时，用默认值补齐（不覆盖已有值）
if (!arg('app-id')) set('appId', cfg.appId ?? 54031);
if (!arg('group-id')) set('groupId', cfg.groupId ?? 40173);
if (!cfg.reply?.signature) set('reply.signature', cfg.reply?.signature ?? '「版主助手-小鲸鱼」');
// 多人协作：队友的 user_id（可留空，靠签名识别）
if (!Array.isArray(cfg.teamUserIds)) set('teamUserIds', cfg.teamUserIds ?? []);
// 玩家喊我们 → 过去互动（aliases 留空，自己按需填自己的其它昵称）
if (!cfg.summon || typeof cfg.summon !== 'object')
  set('summon', cfg.summon ?? {
    enabled: true,
    aliases: [],
    matchRoles: true,
    signature: true,
    answerFromQa: true,
    qaScore: 0.6,
    maxPerRun: 3,
    maxPerPost: 1,
  });

if (changes.length) {
  say('  将要写入：');
  changes.forEach((c) => say(`    ${C.y}${c}${C.x}`));
} else {
  say(`  ${C.g}✓${C.x} 配置已完整`);
}

if (!cfg.myUserId) {
  say(`  ${C.y}!${C.x} 还缺自己的 user_id（config.json 的 myUserId）`);
  say(`      → node scripts/whoami.mjs  拿（要求 Chrome 已登录 TapTap）`);
}

// ---------- ③ 目录 ----------
say(`\n${C.b}3. 运行时目录${C.x}`);
const dirs = ['data', 'reports', join('qa', '归档')];
for (const d of dirs) {
  const p = join(SKILL_ROOT, d);
  const exists = await access(p).then(() => true, () => false);
  if (exists) say(`  ${C.g}✓${C.x} ${d}`);
  else {
    say(`  ${C.y}+${C.x} ${d}`);
    if (!dry) await mkdir(p, { recursive: true });
  }
}

// ---------- ④ 功能就绪矩阵（O7，2026-11-19）----------
say(`\n${C.b}4. 功能就绪矩阵${C.x}`);
{
  const { buildMatrix, renderMatrix } = await import('./lib/readiness.mjs');
  const cfgNow = JSON.parse(await readFile(cfgPath, 'utf8').catch(() => '{}'));
  const m = buildMatrix({ config: cfgNow });
  say(renderMatrix(m, { color: C }));
  say(`  ${C.d}（只提示不自动安装；缺失项对应功能会自行降级）${C.x}`);
}

// ---------- ⑤ 落盘 ----------
if (changes.length) {
  if (dry) {
    say(`\n${C.y}dry-run：跳过写入${C.x}`);
  } else {
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    say(`\n${C.g}✓${C.x} 已写入 ${cfgPath}`);
  }
}

// ---------- ⑥ doctor ----------
say(`\n${C.b}5. 自检${C.x}`);
if (!dry) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'doctor.mjs')], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
} else {
  say(`  ${C.d}(dry-run：跳过)${C.x}`);
}
