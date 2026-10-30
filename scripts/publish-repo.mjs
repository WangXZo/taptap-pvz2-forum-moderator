#!/usr/bin/env node
// 发布：把运行中的 skill 同步到 GitHub 仓库（脱敏）
//
// 为什么要有这个脚本：
//   两份拷贝 —— **运行中**（真 user_id、真昵称、真实答疑库）vs **发布**（脱敏、可公开）。
//   手抄容易漏文件、容易把个人信息带出去，所以做成一个命令：
//     node scripts/publish-repo.mjs --repo <仓库目录>
//   它只做三件事：① 复制代码/文档 ② 写一份脱敏的 config.json ③ 扫一遍个人信息
//
// 脱敏规则（用户 2026-10-29 定）：
//   保留首尾各 1~3 位，中间用 * 补足到统一长度 8 位，保留字符不超过 50%
//   例：'abcdefg'(7位) → 'ab****fg'；'昵称甲'(3字) → '昵******甲'
//   **是脱敏，不是移除** —— 字段和结构都保留，别人照着填自己的就行。
//   ⚠️ 示例只能用**假值** —— 真值写进文档就等于带进仓库（本脚本的扫描会当场抓出来）。
//
// 用法：
//   node scripts/publish-repo.mjs --repo E:/path/to/repo            # 同步 + 体检
//   node scripts/publish-repo.mjs --repo <dir> --check              # 只体检，不写
//   node scripts/publish-repo.mjs --repo <dir> --files a.mjs,b.mjs   # 只同步指定文件

import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, '..');

const argv = process.argv.slice(2);
const arg = (name, def = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const REPO = arg('repo');
if (!REPO) {
  console.error('用法：node scripts/publish-repo.mjs --repo <仓库目录> [--check] [--files a,b]');
  process.exit(1);
}
const CHECK_ONLY = flag('check');
const ONLY_FILES = arg('files')
  ? arg('files').split(',').map((s) => s.trim()).filter(Boolean)
  : null;

/** 要同步的文件（相对 skill 根） */
const DEFAULT_FILES = [
  'SKILL.md',
  'README.md',
  'CONTRIBUTING.md',
  'LICENSE',
  '.gitignore',
  '.gitattributes',
  'package.json',
  'assets/qa-library.example.md',
  'scripts/run-watch.cmd',
  'scripts/schedule.ps1',
  'scripts/api-write.mjs',
  'scripts/collect.mjs',
  'scripts/emoji-map.mjs',
  'scripts/qa-index.mjs',
  'scripts/post-records.mjs',
  'scripts/config.json',
  'scripts/doctor.mjs',
  'scripts/fetch-latest.mjs',
  'scripts/install.mjs',
  'scripts/mod-task.mjs',
  'scripts/mod-watch.mjs',
  'scripts/post-admin.mjs',
  'scripts/probe-dom.mjs',
  'scripts/publish-repo.mjs',
  'scripts/qa-admin.mjs',
  'scripts/qa-sync.mjs',
  'scripts/reply.mjs',
  'scripts/report-gaps.mjs',
  'scripts/report-offline.mjs',
  'scripts/restore-qa.mjs',
  'scripts/test-archive.mjs',
  'scripts/test-api-contents.mjs',
  'scripts/test-match.mjs',
  'scripts/test-mod-task.mjs',
  'scripts/test-post-records.mjs',
  'scripts/test-praise.mjs',
  'scripts/test-qa-health.mjs',
  'scripts/test-qa-vector.mjs',
  'scripts/test-question.mjs',
  'scripts/test-summarize.mjs',
  'scripts/test-summon.mjs',
  'scripts/test-variants.mjs',
  'scripts/watch.mjs',
  'scripts/whoami.mjs',
  'scripts/lib/archive.mjs',
  'scripts/lib/classify.mjs',
  'scripts/lib/db.mjs',
  'scripts/lib/emoji.mjs',
  'scripts/lib/http.mjs',
  'scripts/lib/mod-task.mjs',
  'scripts/lib/mod-report.mjs',
  'scripts/lib/post-records.mjs',
  'scripts/lib/praise-send.mjs',
  'scripts/lib/praise.mjs',
  'scripts/lib/paths.mjs',
  'scripts/lib/qa-health.mjs',
  'scripts/lib/qa-junk.mjs',
  'scripts/lib/qa-vector.mjs',
  'scripts/lib/qa.mjs',
  'scripts/lib/remove-post.mjs',
  'scripts/lib/replier.mjs',
  'scripts/lib/reply-nested.mjs',
  'scripts/lib/report.mjs',
  'scripts/lib/signature.mjs',
  'scripts/lib/state.mjs',
  'scripts/lib/summarize.mjs',
  'scripts/lib/summon-send.mjs',
  'scripts/lib/summon.mjs',
  'scripts/lib/taptap-api.mjs',
  'scripts/lib/usage.mjs',
  'scripts/lib/util.mjs',
  'scripts/lib/variants.mjs',
  'references/api.md',
  'references/admin.md',
  'references/emojis.md',
  'references/mod-task.md',
  'references/ops.md',
  'references/praise.md',
  'references/question-detect.md',
  'references/selectors.md',
  'references/summon.md',
];

/** 脱敏：保留首尾各 1~3 位，中间用 * 补到 8 位（保留 ≤50%） */
export function maskValue(s) {
  const str = String(s ?? '');
  if (!str) return '';
  const len = [...str].length;
  if (len === 1) return '*'.repeat(8);
  if (len <= 5) return [...str][0] + '*'.repeat(6) + [...str][len - 1];
  const keep = len >= 6 ? 2 : 1;
  const head = [...str].slice(0, keep).join('');
  const tail = [...str].slice(-keep).join('');
  return head + '*'.repeat(Math.max(1, 8 - keep * 2)) + tail;
}

/** 生成脱敏后的 config.json */
async function buildMaskedConfig() {
  const cfg = JSON.parse(await readFile(join(SKILL, 'scripts/config.json'), 'utf8'));
  if (cfg.myUserId) cfg.myUserId = maskValue(cfg.myUserId);
  cfg.myUserName = '';
  if (cfg.teamUserIds) cfg.teamUserIds = [];
  if (cfg.summon?.aliases?.length) {
    cfg.summon.aliases = cfg.summon.aliases.map((a) => maskValue(a));
  }
  return cfg;
}

/**
 * 收集「真实好友码」—— 从运行数据里抽，不靠猜
 *
 * 为什么这样做：好友码是**玩家个人数据**（用户 2026-10-30：「好友码，也脱敏」），
 * 但文档里必须举例说明码长什么样。所以文档里一律写 `and********` 这种掩码，
 * 这里把**真实出现过的码**当敏感串来扫 —— 一旦有人在文档里贴了真码，发布当场被拦下。
 */
async function collectRealCodes() {
  const codes = new Set();
  const add = (s) => {
    const v = String(s || '').trim();
    if (v.length >= 6) codes.add(v);
  };
  // ① 管理任务记账里的 inviteCode
  try {
    const st = JSON.parse(await readFile(join(SKILL, 'data/mod-state.json'), 'utf8'));
    for (const p of Object.values(st.posts || {})) add(p?.modTask?.inviteCode);
  } catch {}
  // ② 已移除清单缓存里的正文（含正文里抽出来的码）
  try {
    const cache = JSON.parse(await readFile(join(SKILL, 'data/removed-codes.json'), 'utf8'));
    for (const body of Object.values(cache.body || {})) {
      for (const m of String(body).matchAll(/[A-Za-z][A-Za-z0-9]{5,19}/g)) {
        const t = m[0];
        if (t.length < 6) continue;
        if (!/[0-9]/.test(t) && !/[A-Z]/.test(t)) continue;
        if (/^(taptap|android|iphone|moment|comment|https|www)$/i.test(t)) continue;
        add(t);
      }
    }
  } catch {}
  return [...codes];
}

/** 扫一遍个人信息（真值不该出现在发布目录里） */
async function scanPersonal(dir, secrets) {
  const hits = [];
  // 这些目录是运行时产物 / 被 .gitignore 忽略，不进版本库，不必扫
  const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'reports', 'logs']);
  const walk = async (d) => {
    const { readdir } = await import('node:fs/promises');
    let entries = [];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!/\.(mjs|js|json|md|ps1|cmd|txt)$/i.test(e.name)) continue;
      const text = await readFile(p, 'utf8').catch(() => '');
      for (const s of secrets) {
        if (!s) continue;
        if (text.includes(s)) hits.push({ file: relative(dir, p), secret: s });
      }
    }
  };
  await walk(dir);
  return hits;
}

async function main() {
  const files = ONLY_FILES || DEFAULT_FILES;

  if (!CHECK_ONLY) {
    for (const f of files) {
      if (f === 'scripts/config.json') continue; // 单独处理
      const src = join(SKILL, f);
      const dst = join(REPO, f);
      try {
        await copyFile(src, dst);
        console.log(`  复制 ${f}`);
      } catch (e) {
        console.log(`  跳过 ${f}（源文件不存在：${e.code || e.message}）`);
      }
    }
    // config.json：脱敏后写入
    const cfg = await buildMaskedConfig();
    await mkdir(join(REPO, 'scripts'), { recursive: true });
    await writeFile(join(REPO, 'scripts/config.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    console.log('  写入 scripts/config.json（myUserId / aliases 已脱敏）');
  }

  // 体检：发布目录里不能有真值
  const runCfg = JSON.parse(await readFile(join(SKILL, 'scripts/config.json'), 'utf8'));
  const realCodes = await collectRealCodes();
  const secrets = [
    runCfg.myUserId,
    ...(runCfg.summon?.aliases || []),
    ...(runCfg.teamUserIds || []),
    ...realCodes, // 真实好友码（玩家个人数据，用户 2026-10-30）
  ].filter(Boolean);
  const hits = await scanPersonal(REPO, secrets);
  if (hits.length) {
    console.log('\n❌ 发布目录里发现了真值：');
    for (const h of hits) console.log(`   ${h.file}  含「${h.secret}」`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\n✓ 个人信息扫描通过（扫了 ${secrets.length} 个敏感串：uid / 别名 / 队友 / ${realCodes.length} 个真实好友码）`
  );
}

await main();
