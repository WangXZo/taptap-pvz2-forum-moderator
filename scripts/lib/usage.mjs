// 答疑库条目的「使用统计」—— 决定匹配优先级与归档去留
//
// 单独存放，不写进答疑库正文：
//   - 答疑库是给人看的内容，保持干净
//   - 统计每次命中都要改，写进正文会造成频繁重写
//
// 记录字段（每条 QA 一条）：
//   cited        被引用（命中并用于回复/建议）的次数
//   lastCitedAt  最后一次被引用的时间（ISO）
//   createdAt    首次入库时间（ISO）
//   source       社区沉淀条目的来源链接（人工条目不填）
//   archived     是否已归档（true 时不再参与匹配）

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function loadUsage(file) {
  try {
    const j = JSON.parse(await readFile(file, 'utf8'));
    return { items: {}, lastArchiveAt: null, ...j };
  } catch {
    return { items: {}, lastArchiveAt: null };
  }
}

export async function saveUsage(file, usage) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(usage, null, 2), 'utf8');
}

/** 取某条目的统计（没有就初始化） */
export function statOf(usage, entryId, { source } = {}) {
  if (!usage.items[entryId]) {
    usage.items[entryId] = {
      cited: 0,
      lastCitedAt: null,
      createdAt: new Date().toISOString(),
      source: source || null,
      archived: false,
    };
  }
  return usage.items[entryId];
}

/** 记一次引用（命中并实际用于回复/建议时调用） */
export function recordCitation(usage, entryId, { source } = {}) {
  const s = statOf(usage, entryId, { source });
  s.cited += 1;
  s.lastCitedAt = new Date().toISOString();
  return s;
}

/**
 * 计算条目的排序权重（>1 提升，<1 降低）
 * 规则：用得越多 + 越新 → 权重越高
 *   cited：每次 +0.03，封顶 +0.15
 *   新鲜度：最后引用 7 天内 +0.05；30 天内 +0.02
 *   人工条目 +0.03（人工维护的更可信）
 */
export function weightOf(usage, entry, now = Date.now()) {
  const s = usage.items?.[entry.id];
  let w = 1.0;

  if (s) {
    w += Math.min(0.15, (s.cited || 0) * 0.03);
    const last = s.lastCitedAt ? Date.parse(s.lastCitedAt) : 0;
    if (last) {
      const days = (now - last) / 86400000;
      if (days <= 7) w += 0.05;
      else if (days <= 30) w += 0.02;
    }
  }

  if (!entry.auto) w += 0.03; // 人工条目额外加权
  return w;
}

/**
 * 条目在 qa-usage.json 里的 key
 *
 * 原来这段逻辑在 collect.mjs、post-admin.mjs、qa-admin.mjs 各抄了一份
 * （前两个叫 entryKeyOf，qa-admin 叫 slugOf），三份一模一样 ——
 * 改一处就可能对不上，导致同一条目被算成两条。
 */
export function entryKeyOf(question) {
  return String(question || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/** 距上次归档是否该做（每月 1~5 号，且本月未整理过） */
export function shouldArchive(usage, now = new Date()) {
  const day = now.getDate();
  if (day < 1 || day > 5) return false;
  const last = usage.lastArchiveAt ? new Date(usage.lastArchiveAt) : null;
  if (!last) return true;
  return last.getFullYear() !== now.getFullYear() || last.getMonth() !== now.getMonth();
}
