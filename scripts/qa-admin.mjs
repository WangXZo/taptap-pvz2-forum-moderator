#!/usr/bin/env node
// 答疑库管理工具（增删改查 + 提交管道 + 灾备重建）
//
// 用法：node scripts/qa-admin.mjs <子命令> [参数]
//   submit    --question <问法> --answer-file <文件>        ★ 推荐：提交一条问答
//             （或 --answer "…"；可带 --source --keywords --no-split --dry-run）
//             自动：质量闸 → 拆要点 → 合并 → 原子写入 qa/entries/
//   show      [--source <url>] [--contains <关键词>]   查看条目
//   append    --source <url> --question <问法> --keywords <词,逗号分隔>
//             --answer <答案> [--from <摘自>] [--version 通用]
//             [--answer-file <文件>]                     追加一条（写 qa/entries/）
//   keywords  --source <url> --keywords <词,逗号分隔>   改某条目的关键词
//   register  --source <url> --question <问法>           登记使用统计（手工条目必做）
//   rebuild                                            从 data/qa-usage.json 的来源重建沉淀条目
//   backup                                             手动备份一份到 qa/答疑库.md.backup.md
//   purge-tag [--apply] [--tag <文字>]                 剔除「携带自己标签」的条目（默认只体检）
//   purge-junk [--apply]                               剔除「广告/灌水/分享」等垃圾条目（默认只体检）
//
// 说明：
//   · 2026-11-25 起答疑库是**一条一文件**（qa/entries/<id>.md），运行时优先读目录；
//     单文件 qa/答疑库.md 只是兼容回退，别再往里写
//   · 手工加的条目**必须**再跑一次 register，否则 30 天后会被归档（因为它没有引用记录）
//   * 所有路径都来自 scripts/config.json（跟着 skill 目录走），拷给别人照样能用
//   * 手工加的条目**必须**再跑一次 register，否则 30 天后会被归档（因为它没有引用记录）
//   * 答案里的 \n 会被还原成换行；也可用 --answer-file 读文件
//
// 例子：
//   node scripts/qa-admin.mjs show --contains 塔黄
//   node scripts/qa-admin.mjs append --source https://www.taptap.cn/moment/863832282933232344 \
//        --question "买了塔黄无尽用什么好" --keywords "塔黄,保龄球,卡波" \
//        --answer "直接买神器保龄球；卡波就塔黄空吸到最高再点下一波" --from "枫之****Zo"
//   node scripts/qa-admin.mjs register --source https://www.taptap.cn/moment/863832282933232344 \
//        --question "买了塔黄无尽用什么好"

import { readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { loadConfig, expand } from './lib/paths.mjs';
import { listComments } from './lib/http.mjs';
import { buildQaEntry } from './lib/summarize.mjs';
import { loadState } from './lib/state.mjs';
import { entryKeyOf } from './lib/usage.mjs';
import { tagsFromConfig, purgeTagged } from './lib/qa-health.mjs';
import { purgeJunk, compilePatterns, DEFAULT_JUNK_PATTERNS } from './lib/qa-junk.mjs';
import { maskQa } from './publish-repo.mjs';
import { readAllEntries, slugId, writeEntryFile, sourcesOfEntry } from './lib/qa-entry.mjs';
import { mergeClaims } from './lib/qa-merge.mjs';
import { splitClaims, seedClaimConfidence } from './lib/qa-split.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name, def = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const config = await loadConfig();
const QA = config.paths.qaFile;
const USAGE = config.paths.usageFile;
const STATE = config.paths.stateFile;

const unescape = (s) => String(s || '').replace(/\\n/g, '\n').replace(/\\t/g, '\t');

async function readRaw() {
  try {
    return await readFile(QA, 'utf8');
  } catch {
    return '# 答疑库\n';
  }
}

async function writeRaw(text) {
  await writeFile(QA, text, 'utf8');
}

function splitBlocks(raw) {
  return raw.split(/\n(?=##\s)/g);
}

async function cmdShow() {
  const raw = await readRaw();
  const source = arg('source');
  const contains = arg('contains');
  const blocks = splitBlocks(raw).filter((b) => /^##\s/m.test(b));
  let n = 0;
  for (const b of blocks) {
    if (source && !b.includes(source)) continue;
    if (contains && !b.includes(contains)) continue;
    n++;
    const head = b.match(/^##\s*(.+)$/m)?.[1] || '';
    const src = b.match(/- 来源[:：]\s*(\S+)/)?.[1] || '';
    const auto = /- 来源[:：]/.test(b);
    console.log(`${String(n).padStart(2)}. ${head}`);
    console.log(`    ${auto ? '[沉淀] ' : '[人工] '}${src}`);
  }
  console.log(`\n共 ${blocks.length} 条${source || contains ? `，命中 ${n} 条` : ''}`);
}

async function cmdAppend() {
  const source = arg('source');
  const question = arg('question');
  const keywords = arg('keywords');
  let answer = unescape(arg('answer'));
  const file = arg('answer-file');
  if (file) answer = await readFile(file, 'utf8');
  if (!source || !question || !keywords || !answer) {
    console.error('缺参数：--source / --question / --keywords / --answer');
    process.exit(1);
  }

  // ⚠️ 2026-11-25：必须写进 entries/ 目录 —— 运行时优先读目录，
  //    再写旧的单文件等于写进黑洞（页面上永远看不到）。
  const entriesDir = expand(config.collab?.entriesDir || '{{SKILL}}/qa/entries');
  const existing = await readAllEntries(entriesDir);
  if (existing.some((e) => sourcesOfEntry(e).includes(source))) {
    console.log('已存在同来源条目，跳过（要改内容请用 submit 或直接编辑条目文件）');
    process.exit(0);
  }

  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const from = arg('from');
  const version = arg('version', '通用');

  const entry = {
    id: slugId(question),
    question,
    keywords: keywords.split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean),
    version,
    confidence: null, // 不写 → 由 qa.mjs 按来源性质补默认（有来源=50）
    updated: dateStr,
    source,
    author: from || '',
    claims: [{ text: String(answer).trim(), confidence: 50, sources: [source] }],
  };
  const name = await writeEntryFile(entriesDir, entry, { overwrite: false });
  const count = (await readAllEntries(entriesDir)).length;
  console.log(`已追加：${question.slice(0, 30)} → ${name}（当前 ${count} 条）`);
  console.log('提醒：手工条目还要跑一次 register，否则 30 天后会被归档');
}

async function cmdKeywords() {
  const source = arg('source');
  const keywords = arg('keywords');
  if (!source || !keywords) {
    console.error('缺参数：--source / --keywords');
    process.exit(1);
  }
  const raw = await readRaw();
  let touched = 0;
  const out = splitBlocks(raw).map((b) => {
    if (!b.includes(source)) return b;
    touched++;
    return b.replace(/- 关键词[:：].*/, `- 关键词：${keywords}`);
  });
  if (!touched) {
    console.error('没找到该来源的条目');
    process.exit(1);
  }
  await writeRaw(out.join('\n'));
  console.log(`已更新 ${touched} 条的关键词`);
}

async function cmdRegister() {
  const source = arg('source');
  const question = arg('question');
  if (!source || !question) {
    console.error('缺参数：--source / --question');
    process.exit(1);
  }
  const usage = JSON.parse(await readFile(USAGE, 'utf8').catch(() => '{"items":{}}'));
  const key = entryKeyOf(question);
  if (usage.items?.[key]) {
    console.log(`已存在：${key}`);
    return;
  }
  usage.items = usage.items || {};
  usage.items[key] = {
    cited: 0,
    lastCitedAt: null,
    createdAt: new Date().toISOString(),
    source,
    archived: false,
  };
  await writeFile(USAGE, JSON.stringify(usage, null, 2), 'utf8');
  console.log(`已登记：${key}`);
}

async function cmdBackup() {
  const st = await stat(QA).catch(() => null);
  if (!st || !st.size) {
    console.error('答疑库为空，跳过');
    process.exit(1);
  }
  await copyFile(QA, `${QA}.backup.md`);
  console.log(`已备份到 ${QA}.backup.md`);
}

/**
 * 剔除答疑库里「携带自己标签」的条目
 *
 * 规则（用户 2026-10-28 明确要求）：答疑库**不能**收自己发的夸奖 / 自己的回复。
 * 这类条目的特征就是正文里带着我们自己的签名（当前是「版主助手-小鲸鱼」）。
 *
 * 实现放在 lib/qa-health.mjs —— 守护进程**每天也会自动跑一次**，
 * 共用同一份实现（不写第二份，避免两处行为漂移）。
 *
 * 用法：
 *   node scripts/qa-admin.mjs purge-tag                 # 只体检，不写文件
 *   node scripts/qa-admin.mjs purge-tag --apply         # 真剔除（移到 qa/归档/）
 *   node scripts/qa-admin.mjs purge-tag --tag 小鲸鱼     # 自定义要匹配的标签
 */
async function cmdPurgeTag() {
  const apply = flag('apply');
  const custom = arg('tag');
  const tags = custom ? [custom] : tagsFromConfig(config);

  const res = await purgeTagged({
    qaFile: QA,
    archiveDir: config.paths.archiveDir,
    tags,
    apply,
  });

  if (!res.hits.length) {
    console.log(`答疑库干净：${res.before} 条，没有携带自己标签（${tags.join(' / ')}）的条目`);
    return;
  }

  console.log(`发现 ${res.hits.length} 条携带自己标签的条目：`);
  for (const h of res.hits) console.log(`  ✗ 《${h.question.slice(0, 30)}》  命中「${h.tag}」`);

  if (!apply) {
    console.log('\n（预览模式，没有改动任何文件。确认无误后加 --apply 真剔除）');
    return;
  }

  console.log(`\n已剔除 ${res.hits.length} 条 → 归档到 ${res.archivedFile}`);
  console.log(`主库：${res.before} → ${res.after} 条`);
  console.log(`（改动前的库留在 ${res.backupFile}，要回退直接拷回来）`);
}

/** 从 usage 记录的来源链接重建沉淀条目（灾备） */
async function cmdRebuild() {
  const usage = JSON.parse(await readFile(USAGE, 'utf8').catch(() => '{"items":{}}'));
  const state = await loadState(STATE);
  const raw = await readRaw();
  const KEEP = new Set((arg('keep') || '').split(',').filter(Boolean));
  const manual = splitBlocks(raw).filter((b) => {
    if (!/^##\s/m.test(b)) return false;
    const src = b.match(/- 来源[:：]\s*(https?:\/\/\S+)/)?.[1];
    if (src && !KEEP.has(src.split('/').pop())) return false;
    return true;
  });
  console.log(`保留 ${manual.length} 条（人工 + 精修）`);

  const rebuilt = [];
  for (const [slug, meta] of Object.entries(usage.items || {})) {
    const src = meta.source;
    if (!src) continue;
    const id = src.split('/').pop();
    if (KEEP.has(id)) continue;
    let comments = [];
    try {
      const c = await listComments({ momentId: id, from: 0, limit: 30 });
      comments = c.list || [];
    } catch (e) {
      console.log(`  [跳过] ${slug}：读评论失败 ${e.message}`);
      continue;
    }
    if (!comments.length) {
      console.log(`  [跳过] ${slug}：没有评论了`);
      continue;
    }
    const entry = buildQaEntry({
      post: { url: src, title: state.posts?.[id]?.title || slug.replace(/-/g, ' '), text: '' },
      comments,
      now: new Date(),
      myUserId: config.myUserId,
      signature: config.reply?.signature || '',
    });
    if (!entry) {
      console.log(`  [跳过] ${slug}：按「有效回答」标准没有合格答案`);
      continue;
    }
    rebuilt.push(entry);
    console.log(`  [重建] ${entry.question.slice(0, 26)} ← ${entry.fromAuthor}`);
    await new Promise((r) => setTimeout(r, 1800));
  }

  const header = splitBlocks(raw)[0].trim();
  const out = [header, ''];
  for (const b of manual) out.push(b.trim(), '');
  for (const e of rebuilt) {
    const kw = e.keywords.length ? e.keywords.join(', ') : '';
    out.push(
      `## 问：${e.question}`,
      ...(kw ? [`- 关键词：${kw}`] : []),
      `- 来源：${e.source}`,
      `- 总结时间：${e.summarizedAt}`,
      `- 摘自：${e.fromAuthor}${e.fromBadges?.length ? '（' + e.fromBadges.join('/') + '）' : ''}`,
      '---',
      e.answer,
      ''
    );
  }
  await writeRaw(out.join('\n'));
  console.log(`\n重建完成：${manual.length} + ${rebuilt.length} = ${manual.length + rebuilt.length} 条`);
}

/**
 * 剔除答疑库里的「垃圾条目」（广告 / 灌水 / 分享帖被误收成问答）
 *
 * 背景（2026-10-29）：版主管理任务读了非提问帖的评论，
 * 「加好友呀」这类广告帖被当成「他人已回复 → 沉淀」写进了库。
 *
 * 规则在 config.qa.junkPatterns（正则字符串数组），默认见 lib/qa-junk.mjs。
 * 只看**问法**（标题）；命中就移到 qa/归档/，**不删除**。
 *
 * 用法：
 *   node scripts/qa-admin.mjs purge-junk            # 只体检
 *   node scripts/qa-admin.mjs purge-junk --apply    # 真剔除（归档）
 */
async function cmdPurgeJunk() {
  const apply = flag('apply');
  const patterns = config.qa?.junkPatterns?.length ? config.qa.junkPatterns : DEFAULT_JUNK_PATTERNS;

  const res = await purgeJunk({
    qaFile: QA,
    archiveDir: config.paths.archiveDir,
    patterns,
    apply,
  });

  if (!res.hits.length) {
    console.log(`答疑库干净：${res.before} 条，没有命中垃圾规则`);
    console.log(`（当前规则：${patterns.join(' | ')}）`);
    return;
  }

  console.log(`发现 ${res.hits.length} 条垃圾条目：`);
  for (const h of res.hits) console.log(`  ✗ 《${h.question.slice(0, 30)}》 命中「${h.pattern}」`);

  if (!apply) {
    console.log('\n（只体检，没动文件；加 --apply 才剔除）');
    return;
  }
  console.log(`\n已剔除并归档 → ${res.archivedFile}`);
  console.log(`主库 ${res.before} → ${res.after} 条（备份：${res.backupFile}）`);
}

/**
 * 提交一条问答（2026-11-25 多人协作改造 P4）
 *
 * 贡献者只管**贴一段答案**，其余全自动：
 *   ① 质量闸（垃圾 / 自签名 / 隐私 / 脱敏）
 *   ② 自动拆要点（LLM；拆不动就整段当一个要点）
 *   ③ 与已有条目合并（同问题 → 并入要点；不同问题 → 新条目）
 *   ④ 原子写入条目文件（一条一文件，不覆盖别人的）
 *
 * 用法：
 *   node scripts/qa-admin.mjs submit --question "买了塔黄无尽用什么好" --answer-file 答案.md
 *   node scripts/qa-admin.mjs submit --question "…" --answer "…" [--source URL] [--keywords a,b]
 *   node scripts/qa-admin.mjs submit --question "…" --answer "…" --no-split   # 不调 LLM
 *   node scripts/qa-admin.mjs submit --question "…" --answer "…" --dry-run    # 只看结果不写
 */
async function cmdSubmit() {
  const question = arg('question').trim();
  const answerFile = arg('answer-file');
  let answer = arg('answer');
  if (!answer && answerFile) {
    try {
      answer = await readFile(answerFile, 'utf8');
    } catch (e) {
      console.log(`读不了答案文件：${e.message}`);
      return;
    }
  }
  const source = arg('source').trim();
  const keywordsArg = arg('keywords');
  const dryRun = flag('dry-run');
  const noSplit = flag('no-split');

  if (!question) {
    console.log('缺 --question（问法）');
    return;
  }
  if (!String(answer || '').trim()) {
    console.log('缺答案：给 --answer "…" 或 --answer-file 文件');
    return;
  }

  // ── ① 质量闸 ──
  const reasons = [];

  // ①a 垃圾（求码/加好友/广告）
  const rules = compilePatterns(config.qa?.junkPatterns?.length ? config.qa.junkPatterns : DEFAULT_JUNK_PATTERNS);
  const junk = rules.find((r) => r.re.test(question));
  if (junk) reasons.push(`问法命中垃圾规则「${junk.source}」`);

  // ①b 自签名（我们自己回复过的条目不该进库）
  const sig = (config.reply?.signature || '').trim();
  if (sig && String(answer).includes(sig)) reasons.push('答案里带我们自己的签名');

  // ①c 隐私（手机号/邮箱/QQ群）
  const priv = [
    [/\b1[3-9]\d{9}\b/, '手机号'],
    [/[\w.+-]+@[\w-]+\.[\w.]+/, '邮箱'],
    [/(?:QQ|qq)\s*(?:群)?\s*[:：]?\s*\d{5,}/, 'QQ号/群号'],
  ];
  for (const [re, what] of priv) {
    if (re.test(String(answer))) reasons.push(`答案里出现${what}`);
  }

  if (reasons.length) {
    console.log('❌ 被质量闸拦下：');
    for (const r of reasons) console.log(`  · ${r}`);
    console.log('\n（拿不准就别硬塞 —— 错答案会被自动发出去，比不回答更糟）');
    return;
  }

  // ①d 脱敏（昵称/好友码/天宫码）
  const masked = maskQa(String(answer));
  const clean = masked.text;
  if (masked.names?.length) console.log(`已遮罩昵称 ${masked.names.length} 个`);

  // ── ② 自动拆要点 ──
  let claims = [{ text: clean.trim(), confidence: null }];
  let splitMethod = 'disabled';
  if (!noSplit) {
    try {
      const r = await splitClaims({ answer: clean.trim(), question, config: config.llm || {}, log: () => {} });
      claims = r.claims;
      splitMethod = r.method;
    } catch (e) {
      console.log(`拆要点失败（${e.message}）→ 整段当一个要点`);
    }
  }
  claims = seedClaimConfidence(claims, { source: source || null, manual: !source });

  // ── ③ 与已有条目合并 ──
  const dir = expand(config.collab?.entriesDir || '{{SKILL}}/qa/entries');
  const entries = await readAllEntries(dir);
  const id = slugId(question);
  const existing = entries.find((e) => e.id === id);

  let finalClaims = claims;
  let mode = '新建';
  if (existing) {
    const r = await mergeClaims(existing.claims || [], claims, {});
    finalClaims = r.claims;
    mode = r.merged > 0 ? `补充到已有条目（合并 ${r.merged} 个要点）` : '补充到已有条目（要点不同，作并列补充）';
    if (r.conflicts.length) {
      console.log('⚠️ 与已有要点矛盾，已标 conflict，请人复核：');
      for (const c of r.conflicts) console.log(`  · ${c.text} ↔ ${c.against}`);
    }
  }

  const entry = {
    id,
    question,
    keywords: keywordsArg
      ? keywordsArg.split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean)
      : existing?.keywords || [],
    version: '通用',
    confidence: Math.max(...finalClaims.map((c) => c.confidence || 0)),
    updated: new Date().toISOString().slice(0, 10),
    source: source || existing?.source || '',
    claims: finalClaims,
  };

  console.log(`\n${mode}：${question}`);
  console.log(`要点 ${finalClaims.length} 个（拆分方式：${splitMethod}）：`);
  for (const c of finalClaims) {
    const mark = c.sources?.length ? ` [${c.confidence}% | ${c.sources.length}源]` : ` [${c.confidence}% | 新增]`;
    console.log(`  -${mark} ${c.text.slice(0, 60)}`);
  }

  if (dryRun) {
    console.log('\n[dry-run] 没写文件（加 --apply 或去掉 --dry-run 才会写）');
    return;
  }

  // ── ④ 原子写入 ──
  const name = await writeEntryFile(dir, entry, { overwrite: true });
  console.log(`\n✅ 已写入 ${join(dir, name)}`);
  console.log('（要分享给其他人：等每日合并，或手动跑 node scripts/qa-merge.mjs --apply）');
}

const CMDS = {
  show: cmdShow,
  append: cmdAppend,
  submit: cmdSubmit,
  keywords: cmdKeywords,
  register: cmdRegister,
  rebuild: cmdRebuild,
  backup: cmdBackup,
  'purge-tag': cmdPurgeTag,
  'purge-junk': cmdPurgeJunk,
};

if (!cmd || !CMDS[cmd]) {
  console.log('答疑库管理：node scripts/qa-admin.mjs <子命令>');
  console.log('  show / append / keywords / register / rebuild / backup / purge-tag');
  console.log('  详细说明见 references/admin.md');
  process.exit(cmd ? 1 : 0);
}

await CMDS[cmd]();
