// 答疑库体检：剔除「携带自己标签」的条目
//
// 规则（用户 2026-10-28 明确要求）：
//   **答疑库里绝不能收自己发的夸奖 / 自己的回复。**
//   这类条目的特征就是正文里带着我们自己的签名（当前是「版主助手-小鲸鱼」）。
//
// 为什么单独抽成模块：
//   这个问题**反复发作** —— `scoreReply` 给版主 +4、给答疑徽章 +4，我自己就是版主，
//   所以我盖的夸奖楼得分最高，曾被当成「最佳答案」沉淀进库，库里的「答案」变成
//   「依******梦 说得又准又细，省了大家很多摸索 「版主助手-小鲸鱼」」。
//   生成端已经硬挡（buildQaEntry 排除自己），但存量需要能随时体检 + 清理，
//   而且守护进程要能每天自动跑一次 —— 所以必须是**一份实现、两处调用**
//   （`qa-admin purge-tag` 手动跑 / `collect.mjs` 每天自动跑），不能各写一份。
//
// 清理方式沿用归档策略：**只移动不删除**。

import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
// 标签推导统一放在 lib/signature.mjs（签名识别、答疑库体检、喊话判定共用一套，
// 免得「签名改了但体检还用老规则」这类漂移）。这里只是转出去，保持老调用点不变。
import { FALLBACK_TAGS, tagsFromConfig } from './signature.mjs';

export { FALLBACK_TAGS, tagsFromConfig };

/**
 * 扫描答疑库原文，分出「命中标签」的块和「保留」的块
 *
 * ⚠️ 只查每块 `---` **之后**的正文：
 *    元数据里「摘自：…」出现名字不算（那只是署名），避免误伤正常条目。
 *
 * @returns {{header:string, hits:Array<{block:string, tag:string, question:string}>, keep:string[]}}
 */
export function scanTagged(raw, tags = FALLBACK_TAGS) {
  const parts = String(raw || '').split(/\n(?=##\s)/g);
  const header = parts[0] || '';
  const hits = [];
  const keep = [];

  for (const b of parts.slice(1)) {
    if (!/^##\s/m.test(b)) {
      if (b.trim()) keep.push(b);
      continue;
    }
    const i = b.indexOf('\n---');
    const body = i >= 0 ? b.slice(i + 4) : b;
    const tag = tags.find((t) => t && body.includes(t));
    if (tag) {
      const question = (b.match(/^##\s*(?:问：)?(.*)$/m)?.[1] || '').trim();
      hits.push({ block: b, tag, question });
    } else {
      keep.push(b);
    }
  }
  return { header, hits, keep };
}

/** 把 header + 保留块重新拼成库文件内容 */
export function renderLibrary(header, keep) {
  return [String(header || '').trim(), '', ...keep.map((b) => String(b).trim()), ''].join('\n');
}

/**
 * 体检 + （可选）剔除
 *
 * @param {object} o
 * @param {string} o.qaFile      答疑库文件
 * @param {string} o.archiveDir  归档目录
 * @param {string[]} o.tags      要匹配的标签
 * @param {boolean} [o.apply]    true=真剔除；false=只体检（默认）
 * @param {Date} [o.now]
 * @returns {Promise<{hits:Array, before:number, after:number, archivedFile:string|null, backupFile:string|null}>}
 */
export async function purgeTagged({ qaFile, archiveDir, tags = FALLBACK_TAGS, apply = false, now = new Date() }) {
  let raw = '';
  try {
    raw = await readFile(qaFile, 'utf8');
  } catch {
    return { hits: [], before: 0, after: 0, archivedFile: null, backupFile: null };
  }

  const { header, hits, keep } = scanTagged(raw, tags);
  const before = hits.length + keep.filter((b) => /^##\s/m.test(b)).length;
  if (!hits.length || !apply) {
    return { hits, before, after: before, archivedFile: null, backupFile: null };
  }

  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;

  // 1) 归档（只移动不删除）
  await mkdir(archiveDir, { recursive: true }).catch(() => {});
  const archivedFile = `${archiveDir}/答疑库-剔除自己标签-${stamp}.md`;
  let prev = '';
  try {
    prev = await readFile(archivedFile, 'utf8');
  } catch {
    prev =
      `# 答疑库 · 剔除「携带自己标签」的条目（${stamp}）\n\n` +
      `> 这些条目的正文里带着我们自己的签名（${tags.join(' / ')}），\n` +
      `> 说明它其实是**我自己的夸奖或回复**，被沉淀逻辑误当成「社区答案」收进来了。\n` +
      `> 从主库剔除，但**没有删除**，随时可以拷回 qa/答疑库.md。\n\n---\n`;
  }
  const append = hits.map((h) => `\n<!-- 命中标签：${h.tag} -->\n${h.block.trim()}\n`).join('\n');
  await writeFile(archivedFile, prev.replace(/\s*$/, '\n') + append, 'utf8');

  // 2) 先备份再重写主库
  const backupFile = `${qaFile}.before-purge-${stamp}`;
  await copyFile(qaFile, backupFile).catch(() => {});
  await writeFile(qaFile, renderLibrary(header, keep), 'utf8');

  const after = keep.filter((b) => /^##\s/m.test(b)).length;
  return { hits, before, after, archivedFile, backupFile };
}

/**
 * 今天该不该体检（默认 24 小时一次）
 *
 * 用户明确要求：「可以体检，但是我不希望频率太高，每天就行。
 *                如果需要，可以主动申请。」
 * → 所以默认 24h，别偷偷改成每轮。真要更频繁，得先问用户。
 */
export function shouldHealthCheck(usage, now = new Date(), everyHours = 24) {
  const last = usage?.lastHealthAt ? new Date(usage.lastHealthAt) : null;
  if (!last || Number.isNaN(last.getTime())) return true;
  return now.getTime() - last.getTime() >= Number(everyHours) * 3600 * 1000;
}
