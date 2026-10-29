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

/** 默认垃圾规则（可在 config.qa.junkPatterns 覆盖） */
export const DEFAULT_JUNK_PATTERNS = [
  '加好友',
  '好友码',
  '集中贴',
  '加我好友',
  '^账号$',
  '^已有\\d+人$',
  '^暗物质火龙果真强$',
  '^又是没出萝卜的一天$',
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
