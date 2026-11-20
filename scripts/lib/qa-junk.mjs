// 答疑库「垃圾条目」剔除：广告 / 灌水 / 分享帖被误当成问答收进来
//
// 背景（2026-10-29 实测事故）：版主管理任务读了非提问帖的评论，
// 于是「欢迎大家加我好友and4LM27NKN」「加好友呀」这种广告帖被当成「他人已回复 → 沉淀」，
// 写进了答疑库。**只移动不删除**，跟 purge-tag 一个套路。
//
// 判定只看**问法**（标题），不看正文 —— 正文可能正常，标题才是垃圾特征。
//
// 规则放在 config.qa.junkPatterns（正则字符串数组），改规则不用改代码。

import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';

/** 默认垃圾规则（可在 config.qa.junkPatterns 覆盖）
 *  ⚠️ junk 层 = **语义上不是问答**（求码/加好友/广告）—— **不看 cited，命中即剔**。
 *  2026-11-18 真实链接验证补充：「大佬们快加我」这类**不含"加好友"字样**的漏网条目，
 *  实测仍在 v2 检索里被求码帖/加好友帖命中（0.52~0.68），必须补规则。 */
export const DEFAULT_JUNK_PATTERNS = [
  '加好友',
  '好友码',
  '集中贴',
  '加我好友',
  '快加我',
  '加个好友',
  '^账号$',
  '^已有\\d+人$',
  '^暗物质火龙果真强$',
  '^又是没出萝卜的一天$',
  // 求码帖不该进答疑库（2026-11-10）：问题是「求码」、答案也是「求码」，一问一答全是废话，
  // 还会被当成「社区已答」拿去回别人。
  '(求|蹲|想要|来个|有没有|给个|谁有|求个).{0,6}(天宫码|兑换码|激活码|礼包码)',
];

/** 噪声层默认规则（2026-11-18 O3）：**无信息标题**（纯情绪/疑问代词/指代不明）。
 *  与 junk 层不同：噪声层对 `cited>0` 的条目**豁免**（有引用说明确实回答过玩家）。
 *
 *  ⚠️ 2026-11-18 dry-run 教训：**不要用 `^.{0,5}$` 这种泛规则** —— 真实库会被误伤
 *  《摇滚无尽》《紫手套》《地宫秘境》《万圣节活动》《无尽》《神器》等**真知识条目**（短标题≠无信息，
 *  它们正是游戏实体名）。改为「明确无信息词表」+ `shortWithShortAnswer` 组合判据（问短且答也短）。 */
export const DEFAULT_NOISE_PATTERNS = [
  '^(如题|疑问|求助|rt|同上|求解|急|在线等|求求了)$',
  '^(绝望|燃尽了|麻了|无语|离谱|笑死|崩溃|破防|蚌埠|白给|阴间|真服了|吓哭了|这也太霉了)$',
  '^(伙伴|关于大哥|保留节目|几个意思|力竭之|私人拖尾|有申请上线|草垛)$', // 指代不明 / 纯闲话
];

/** 把配置里的规则字符串编译成正则（写错的规则直接跳过，不让一条坏规则毁掉整个命令） */
export function compilePatterns(patterns = DEFAULT_JUNK_PATTERNS) {
  const out = [];
  for (const p of patterns) {
    try {
      out.push({ source: String(p), re: new RegExp(String(p), 'i') });
    } catch {
      /* 忽略非法正则 */
    }
  }
  return out;
}

/**
 * 扫描答疑库，分出「垃圾块」和「保留块」
 * @returns {{header:string, hits:Array<{block:string, question:string, pattern:string}>, keep:string[], before:number}}
 */
export function scanJunk(raw, patterns = DEFAULT_JUNK_PATTERNS) {
  const rules = compilePatterns(patterns);
  const parts = String(raw || '').split(/\n(?=##\s)/g);
  const header = parts[0] || '';
  const hits = [];
  const keep = [];

  for (const b of parts.slice(1)) {
    if (!/^##\s/m.test(b)) {
      if (b.trim()) keep.push(b);
      continue;
    }
    const question = (b.match(/^##\s*(?:问：)?(.*)$/m)?.[1] || '').trim();
    const hit = rules.find((r) => r.re.test(question));
    if (hit) hits.push({ block: b, question, pattern: hit.source });
    else keep.push(b);
  }
  return { header, hits, keep, before: hits.length + keep.filter((b) => /^##\s/m.test(b)).length };
}

/**
 * 分层扫描（2026-11-18 O3）：junk 层命中即剔（不看 cited）；噪声层对 cited>0 豁免。
 * @param {string} raw 答疑库原文
 * @param {object} o
 * @param {string[]} [o.junkPatterns]  语义非问答（求码/加好友/广告）
 * @param {string[]} [o.noisePatterns] 无信息标题（纯情绪/疑问代词/指代不明）
 * @param {Function} [o.citedOf] (question) => 引用次数（决定噪声层豁免）
 * @param {number} [o.shortQuestionLen=0]   组合判据（默认关闭＝0）：问句长度 ≤ 此值
 * @param {number} [o.shortAnswerLen=12]    组合判据：且答案长度 ≤ 此值 → 判噪声
 *   ⚠️ 2026-11-18 二次教训：**默认关闭组合判据**。启用会把「困难6怎么过」(6字)+「用冰车加机枪」(7字)
 *   这类**有效短问答**也剔掉 —— 短 ≠ 无信息。要开就显式配（如 <=4 且答案 <=6），并先 dry-run 看清单。
 * @returns {{header:string, hits:Array<{block,question,layer,pattern}>, keep:string[], before:number, exempted:number}}
 */
export function scanJunkLayered(raw, {
  junkPatterns = DEFAULT_JUNK_PATTERNS,
  noisePatterns = DEFAULT_NOISE_PATTERNS,
  citedOf = null,
  shortQuestionLen = 0,
  shortAnswerLen = 12,
} = {}) {
  const junkRules = compilePatterns(junkPatterns);
  const noiseRules = compilePatterns(noisePatterns);
  const parts = String(raw || '').split(/\n(?=##\s)/g);
  const header = parts[0] || '';
  const hits = [];
  const keep = [];
  let exempted = 0;

  for (const b of parts.slice(1)) {
    if (!/^##\s/m.test(b)) {
      if (b.trim()) keep.push(b);
      continue;
    }
    const question = (b.match(/^##\s*(?:问：)?(.*)$/m)?.[1] || '').trim();
    // ① junk 层：命中即剔（语义上不是问答，引用再多也不该拿来回别人）
    const jr = junkRules.find((r) => r.re.test(question));
    if (jr) {
      hits.push({ block: b, question, layer: 'junk', pattern: jr.source });
      continue;
    }
    // ② 噪声层：明确无信息词表（短问+短答组合判据默认关闭，见函数注释）
    const answer = (b.split(/\n---\n/)[1] || '').replace(/\s+/g, '').trim();
    const nr = noiseRules.find((r) => r.re.test(question));
    const shortPair = shortQuestionLen > 0 && question.length <= shortQuestionLen && answer.length <= shortAnswerLen;
    if (nr || shortPair) {
      const cited = typeof citedOf === 'function' ? Number(citedOf(question) || 0) : 0;
      if (cited > 0) {
        exempted++;
        keep.push(b);
      } else {
        hits.push({
          block: b,
          question,
          layer: 'noise',
          pattern: nr ? nr.source : `短问(${question.length})+短答(${answer.length})`,
        });
      }
      continue;
    }
    keep.push(b);
  }
  return { header, hits, keep, before: hits.length + keep.filter((b) => /^##\s/m.test(b)).length, exempted };
}

/**
 * 剔除垃圾条目（只移动不删除）
 *
 * @param {object} o
 * @param {string} o.qaFile
 * @param {string} o.archiveDir
 * @param {string[]} [o.patterns]
 * @param {boolean} [o.apply]   true=真剔除；false=只体检
 * @param {Date} [o.now]
 */
export async function purgeJunk({ qaFile, archiveDir, patterns = DEFAULT_JUNK_PATTERNS, apply = false, now = new Date() }) {
  let raw = '';
  try {
    raw = await readFile(qaFile, 'utf8');
  } catch {
    return { hits: [], before: 0, after: 0, archivedFile: null, backupFile: null };
  }

  const { header, hits, keep, before } = scanJunk(raw, patterns);
  if (!hits.length || !apply) {
    return { hits, before, after: before, archivedFile: null, backupFile: null };
  }

  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;

  await mkdir(archiveDir, { recursive: true }).catch(() => {});
  const archivedFile = `${archiveDir}/答疑库-剔除垃圾-${stamp}.md`;
  let prev = '';
  try {
    prev = await readFile(archivedFile, 'utf8');
  } catch {
    prev =
      `# 答疑库 · 剔除垃圾条目（${stamp}）\n\n` +
      `> 这些条目是**广告/灌水/分享帖**，不是问题，更不是答案 —— 沉淀逻辑误把它们收进来了。\n` +
      `> 已从主库剔除，**没有删除**，随时可以拷回 qa/答疑库.md。\n\n---\n`;
  }
  const append = hits.map((h) => `\n<!-- 命中规则：${h.pattern} -->\n${h.block.trim()}\n`).join('');
  await writeFile(archivedFile, prev.replace(/\s*$/, '\n') + append, 'utf8');

  const backupFile = `${qaFile}.before-purge-junk-${stamp}`;
  await copyFile(qaFile, backupFile).catch(() => {});
  await writeFile(qaFile, [header.trim(), '', ...keep.map((b) => b.trim()), ''].join('\n'), 'utf8');

  const after = keep.filter((b) => /^##\s/m.test(b)).length;
  return { hits, before, after, archivedFile, backupFile };
}
