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
/** 是否「直接运行」（被 import 时（比如回归测试）不校验参数、不执行 main） */
const IS_MAIN = Boolean(process.argv[1] && /publish-repo\.mjs$/.test(process.argv[1]));
if (IS_MAIN && !REPO) {
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
  'qa/答疑库.md',
  'scripts/run-watch.cmd',
  'scripts/schedule.ps1',
  'scripts/api-write.mjs',
  'scripts/collect.mjs',
  'scripts/emoji-map.mjs',
  'scripts/qa-index.mjs',
  'scripts/post-records.mjs',
  'scripts/removed-list.mjs',
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
  'scripts/test-cold-store.mjs',
  'scripts/test-comfort.mjs',
  'scripts/test-publish-mask.mjs',
  'scripts/test-interact.mjs',
  'scripts/test-limits-codes.mjs',
  'scripts/test-match.mjs',
  'scripts/test-mod-task.mjs',
  'scripts/test-post-records.mjs',
  'scripts/test-removed-list.mjs',
  'scripts/test-praise.mjs',
  'scripts/test-qa-health.mjs',
  'scripts/test-qa-vector.mjs',
  'scripts/test-question.mjs',
  'scripts/test-summarize.mjs',
  'scripts/test-summon.mjs',
  'scripts/test-thread-context.mjs',
  'scripts/test-variants.mjs',
  'scripts/test-watch-queue.mjs',
  'scripts/cold-store.mjs',
  'scripts/watch.mjs',
  'scripts/waf.mjs',
  'scripts/whoami.mjs',
  'scripts/lib/archive.mjs',
  'scripts/lib/classify.mjs',
  'scripts/lib/db.mjs',
  'scripts/lib/emoji.mjs',
  'scripts/lib/http.mjs',
  'scripts/lib/page-fetch.mjs',
  'scripts/lib/mod-task.mjs',
  'scripts/lib/mod-report.mjs',
  'scripts/lib/code-guard.mjs',
  'scripts/lib/cold-store.mjs',
  'scripts/lib/compose-reply.mjs',
  'scripts/lib/cross-check.mjs',
  'scripts/lib/db.mjs',
  'scripts/lib/emoji.mjs',
  'scripts/lib/http.mjs',
  'scripts/lib/interact.mjs',
  'scripts/lib/interact-send.mjs',
  'scripts/lib/limits.mjs',
  'scripts/lib/llm.mjs',
  'scripts/lib/mod-seen.mjs',
  'scripts/lib/notify.mjs',
  'scripts/lib/post-records.mjs',
  'scripts/lib/praise-send.mjs',
  'scripts/lib/praise-store.mjs',
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
  'scripts/lib/single-instance.mjs',
  'scripts/lib/state.mjs',
  'scripts/lib/summarize.mjs',
  'scripts/lib/summon-send.mjs',
  'scripts/lib/summon.mjs',
  'scripts/lib/taptap-api.mjs',
  'scripts/lib/thread-context.mjs',
  'scripts/lib/usage.mjs',
  'scripts/lib/util.mjs',
  'scripts/lib/variants.mjs',
  'scripts/lib/waf-unlock.mjs',
  'scripts/lib/watch-queue.mjs',
  'references/api.md',
  'references/admin.md',
  'references/emojis.md',
  'references/mod-task.md',
  'references/ops.md',
  'references/praise.md',
  'references/question-detect.md',
  'references/selectors.md',
  'references/summon.md',
  'docs/方案.md',
  'docs/github-survey.md',
  'docs/evidence/01-facts.md',
  '人工命令启动说明.md',
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

/**
 * 助手别称（**不是隐私**，用户 2026-11-05 确认）
 *
 * 这些是我们自己助手的昵称，公开写在代码和文档里，玩家喊我们时也要认。
 * 所以它们**不当敏感串扫**，也不脱敏 —— 只有真正的个人隐私（uid / 队友 uid / 真实好友码）才拦。
 */
const PUBLIC_ALIASES = ['大肥鱼', '吃白米饭的'];

/** 生成脱敏后的 config.json */
async function buildMaskedConfig() {
  const cfg = JSON.parse(await readFile(join(SKILL, 'scripts/config.json'), 'utf8'));
  if (cfg.myUserId) cfg.myUserId = maskValue(cfg.myUserId);
  if (cfg.myUserName) delete cfg.myUserName; // 旧版本残留字段（有就删）
  if (cfg.teamUserIds) cfg.teamUserIds = [];
  if (cfg.summon?.aliases?.length) {
    // 助手别称保持原样（公开称呼），其它马甲照常脱敏
    cfg.summon.aliases = cfg.summon.aliases.map((a) =>
      PUBLIC_ALIASES.includes(a) ? a : maskValue(a)
    );
  }
  return cfg;
}

/** 答疑库文件（脱敏后单独写，不走普通复制） */
const QA_FILE = 'qa/答疑库.md';
/** 事实核验记录（脱敏后单独写） */
const EVIDENCE_FILE = 'docs/evidence/01-facts.md';

/**
 * 这个昵称有没有隐私价值？
 *
 * 「摘自」行里会混进一些**没信息量**的名字：`123`、`我`、`A`……
 * 它们当敏感串去扫全仓库 → 每个文件都命中（谁还没写过「我」字）→ 扫描直接不可用。
 * 判断标准：**至少 2 个汉字**（昵称基本都是中文；`123`/`abc` 这种不算个人标识）。
 */
function meaningfulName(name) {
  const s = String(name || '').trim();
  if (!s) return false;
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  return cjk >= 2;
}

/**
 * 答疑库脱敏（用户 2026-11-05：答疑库**恢复随仓库分发**，但必须脱敏）
 *
 * 只遮罩四类东西，答案本身要保留可读性：
 *   ① `- 摘自：玩家昵称（徽章）` → 昵称遮罩，徽章保留
 *   ② 真实好友码（and/ios + 8 位）
 *   ③ 天宫码（JFA + 7 位）—— 是具体玩家的码，不该进公开仓库
 *   ④ **正文里**出现的同一个真实昵称 → 一并遮（否则从正文漏出去）
 *
 * ⚠️ 2026-11-10 补：拿到「摘自」里的真实昵称后，还要把**正文里**的同一昵称一起替换掉 ——
 *    玩家会在答案正文里被提到（例：「依星&寻梦补充过：……」），
 *    只遮「摘自」行的话，昵称照样从正文漏出去。
 *    没信息量的昵称（`123`、`我`）不遮也不扫 —— 否则整个仓库都是误报。
 *
 * 不动的：`- 来源：https://...`（可追溯性，不是个人信息）、问题正文、答案正文、
 *        帖子标题里带的关卡号（公开内容）。
 *
 * @returns {{text:string, names:string[]}} names = 抽出来的真实昵称，供后面的扫描当敏感串
 */
export function maskQa(text) {
  const names = new Set();
  let out = String(text || '');

  // ①「- 摘自：昵称（徽章）」→ 昵称遮罩
  out = out.replace(/^(\s*-\s*摘自：)(.+)$/gm, (_m, prefix, rest) => {
    const mm = String(rest).match(/^(.+?)(（[^）]*）)?\s*$/);
    const name = String(mm ? mm[1] : rest).trim();
    const badge = mm && mm[2] ? mm[2] : '';
    if (!name) return prefix + rest;
    if (name.includes('*')) return prefix + rest; // 已经遮过 → 保持幂等，别二次遮
    if (!meaningfulName(name)) return prefix + rest; // `123`/`我` 这种不遮（遮了没法读，也不算隐私）
    names.add(name);
    return prefix + maskValue(name) + badge;
  });

  // ② 好友码 / ③ 天宫码 → 统一遮罩
  out = out.replace(/\b(?:and|ios)[A-Za-z0-9]{8}\b/g, (m) => maskValue(m));
  out = out.replace(/\bJFA[A-Za-z0-9]{7}\b/g, (m) => maskValue(m));

  // ④ 正文里出现的同一个昵称 → 一并遮掉（否则从正文漏出去）
  for (const name of names) {
    if (!out.includes(name)) continue;
    out = out.split(name).join(maskValue(name));
  }

  return { text: out, names: [...names] };
}

/**
 * 事实核验记录脱敏（docs/evidence/01-facts.md，用户 2026-11-05）
 *
 * 那份文档是「可行性」的一手证据（官方 CLI 只读、1557 条接口路径逆向、实测结论），
 * 要**完整**进仓库。只遮三类，接口路径 / 命令 / 结论一个字不动：
 *   ① 本机路径里的 Windows 用户名   C:\Users\WangXZ\ → C:\Users\Wa****Z\
 *   ② 真实好友码 / 天宫码
 *   ③ @ 提及的玩家昵称
 *   ④ 传进来的敏感串（我的 uid / 队友 uid / 答疑库里抽出的玩家昵称）—— **精确遮，不误伤帖子 id**
 *
 * 帖子 id / 评论 id **不遮** —— 那是平台公开内容，遮了反而失去证据价值。
 *
 * @param {string} text
 * @param {{secrets?:string[]}} [opt]
 */
export function maskEvidence(text, { secrets = [] } = {}) {
  let out = String(text || '');
  // ① 本机路径里的用户名（系统账户不遮）
  out = out.replace(/([A-Za-z]:\\Users\\)([^\\\s`"']+)/g, (m, prefix, user) =>
    /^(Public|Default|All Users|Default User)$/i.test(user) ? m : prefix + maskValue(user)
  );
  // ② 好友码 / 天宫码
  out = out.replace(/\b(?:and|ios)[A-Za-z0-9]{8}\b/g, (m) => maskValue(m));
  out = out.replace(/\bJFA[A-Za-z0-9]{7}\b/g, (m) => maskValue(m));
  // ③ @昵称（@taptap / @here 这类非人名不遮；遇到路径分隔符就截断，别把 npm 路径当昵称）
  out = out.replace(/([@＠])([^\s，,。:：()（）\[\]{}"'\\/]{2,20})/g, (m, at, name) =>
    /^(taptap|here|all|everyone)$/i.test(name) ? m : at + maskValue(name)
  );
  // ④ 指定敏感串（我的 uid / 队友 uid / 答疑库里抽出的昵称）—— 精确替换，不误伤帖子 id
  for (const s of secrets) {
    const v = String(s || '');
    if (v.length < 2) continue;
    if (out.includes(v)) out = out.split(v).join(maskValue(v));
  }
  return out;
}

/**
 * 覆盖度校验：skill 里有、但发布清单里没列的文件
 *
 * 为什么需要：DEFAULT_FILES 是**手写白名单** —— 新增脚本忘了加进去，
 * 仓库里就会少一个文件，而发布过程不会报错（就是「多版本并存」的老毛病）。
 * 2026-11-05 真踩到一次：`test-publish-mask.mjs` 漏了，直到三方比对才发现。
 */
async function findUnlisted(files) {
  const { readdir } = await import('node:fs/promises');
  const { sep } = await import('node:path');
  const listed = new Set(files);
  const SPECIAL = new Set(['scripts/config.json', QA_FILE, EVIDENCE_FILE]); // 单独脱敏写入
  const SKIP_DIRS = new Set(['data', 'reports', 'qa', 'logs', 'node_modules', '.git']);
  const missing = [];
  const walk = async (dir) => {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      const rel = relative(SKILL, p).split(sep).join('/');
      if (!/\.(mjs|md|json|ps1|cmd|txt)$/i.test(rel)) continue;
      if (listed.has(rel) || SPECIAL.has(rel)) continue;
      missing.push(rel);
    }
  };
  await walk(SKILL);
  return missing.sort();
}

/**
 * 收集「真实好友码」—— 从运行数据里抽，不靠猜
 *
 * 为什么这样做：好友码是**玩家个人数据**（用户 2026-10-30：「好友码，也脱敏」），
 * 但文档里必须举例说明码长什么样。所以文档里一律写 `andABCDEFGH` 这种掩码，
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
      if (f === 'scripts/config.json') continue; // 单独处理（脱敏）
      if (f === QA_FILE) continue; // 单独处理（脱敏）
      if (f === EVIDENCE_FILE) continue; // 单独处理（脱敏）
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
    console.log('  写入 scripts/config.json（myUserId / 私有马甲 已脱敏；助手别称保留）');
  }

  // 答疑库：脱敏后写入（名字要在扫描前抽出来）
  let qaNames = [];
  if (!CHECK_ONLY) {
    try {
      const raw = await readFile(join(SKILL, QA_FILE), 'utf8');
      const masked = maskQa(raw);
      qaNames = masked.names;
      await mkdir(join(REPO, 'qa'), { recursive: true });
      await writeFile(join(REPO, QA_FILE), masked.text, 'utf8');
      console.log(`  写入 ${QA_FILE}（摘自昵称遮罩 ${qaNames.length} 个）`);
    } catch (e) {
      console.log(`  跳过 ${QA_FILE}（读不到：${e.code || e.message}）`);
    }
  }

  // 事实核验记录：脱敏后写入（保留完整证据链，只遮本机用户名 / 码 / @昵称 / 我的 uid / 玩家昵称）
  if (!CHECK_ONLY) {
    try {
      const raw = await readFile(join(SKILL, EVIDENCE_FILE), 'utf8');
      const runCfg2 = JSON.parse(await readFile(join(SKILL, 'scripts/config.json'), 'utf8'));
      const evSecrets = [
        runCfg2.myUserId,
        ...(runCfg2.teamUserIds || []),
        ...qaNames, // 答疑库里抽出来的玩家昵称，evidence 里可能也提到
      ].filter(Boolean);
      await mkdir(join(REPO, 'docs', 'evidence'), { recursive: true });
      await writeFile(join(REPO, EVIDENCE_FILE), maskEvidence(raw, { secrets: evSecrets }), 'utf8');
      console.log(`  写入 ${EVIDENCE_FILE}（本机用户名 / 码 / @昵称 / ${evSecrets.length} 个指定敏感串已脱敏）`);
    } catch (e) {
      console.log(`  跳过 ${EVIDENCE_FILE}（读不到：${e.code || e.message}）`);
    }
  }

  // 体检①：发布清单覆盖度（防手写白名单漏文件 —— 2026-11-05 真踩到过）
  const unlisted = await findUnlisted(DEFAULT_FILES);
  if (unlisted.length) {
    console.log('\n⚠️ 这些文件在 skill 里存在、但发布清单没列（不会进仓库）：');
    for (const f of unlisted) console.log(`   ${f}`);
    console.log('   → 要发就加进 publish-repo.mjs 的 DEFAULT_FILES');
  }

  // 体检②：发布目录里不能有真值
  const runCfg = JSON.parse(await readFile(join(SKILL, 'scripts/config.json'), 'utf8'));
  const realCodes = await collectRealCodes();
  const secrets = [
    runCfg.myUserId,
    ...(runCfg.summon?.aliases || []).filter((a) => !PUBLIC_ALIASES.includes(a)),
    ...(runCfg.teamUserIds || []),
    ...realCodes, // 真实好友码（玩家个人数据，用户 2026-10-30）
    ...qaNames, // 答疑库里「摘自」的玩家昵称（脱敏时抽出来的）
  ].filter(Boolean);
  const hits = await scanPersonal(REPO, secrets);
  if (hits.length) {
    console.log('\n❌ 发布目录里发现了真值：');
    for (const h of hits) console.log(`   ${h.file}  含「${h.secret}」`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\n✓ 个人信息扫描通过（扫了 ${secrets.length} 个敏感串：uid / 私有马甲 / 队友 / ${realCodes.length} 个真实好友码；助手别称不属隐私，不扫）`
  );
}

// 只在**直接运行**时执行（被 import 时不跑 main，方便写回归测试）
if (IS_MAIN) await main();
