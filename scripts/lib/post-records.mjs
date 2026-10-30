// 帖子处理记录 → SQLite（逐行写，不互相覆盖，可裁剪可归档）
//
// 为什么要有这层：
//   1) state.json 是「整份重写」—— 记了几百条帖子后每次改一条都要重写几百 KB，
//      而且两个进程各写各的内存副本时，后写的会把先写的冲掉（踩过：丢过 172 条移除记录）。
//   2) SQLite 是**逐行 upsert**，多进程各写各的行，互不干扰；还能按时间裁剪、按状态统计。
//   3) 老记录可以从 state.json **搬到** SQLite（搬，不是丢）：state.json 只留近期热数据，
//      体积回落到几十 KB；历史在库里查得到、删得掉。
//
// 三张表（见 lib/db.mjs）：post_record（当前状态）/ post_event（事件流水）/ qa_vec（答疑向量）

import { openDb, upsertPost, updatePost, logEvent, getPost, isPostDone, listPosts, listEvents, stats, prunePosts } from './db.mjs';
import { STATUS } from './state.mjs';

/** 打开帖子记录库（没有配置就用 data/post-records.sqlite） */
export function openPostDb(config) {
  const file = config?.paths?.postDbFile || `${config?.paths?.dataDir || 'data'}/post-records.sqlite`;
  return openDb(file);
}

/** 记一次「看到了这个帖子」（答疑守护用：判定结果写 qa_status，不和管理任务抢 status 列） */
export function recordScanned(db, post, extra = {}) {
  if (!db || !post?.id) return;
  upsertPost(db, {
    id: String(post.id),
    url: post.url,
    title: post.title,
    author: post.author,
    authorId: post.authorId,
    board: extra.board || post.board || null,
    publishTime: post.publishTime,
    status: extra.status ?? null,
    qaStatus: extra.qaStatus ?? null,
    keyword: extra.keyword || null,
    inviteCode: extra.inviteCode || null,
    stage: extra.stage || null,
    detail: extra.detail ? { ...extra.detail, normKey: post.normKey || null } : null,
  });
}

/** 管理任务的终态（一旦到达就不要再被后续扫描覆盖） */
const MOD_TERMINAL = new Set(['replied', 'removed', 'manual_remove', 'failed', 'replied_only']);

/**
 * 管理任务记一次「扫到了这个帖子」
 *
 * ⚠️ 关键：**终态不能被覆盖**。
 *    一条已经「removed」的帖子如果被再次扫到，状态不能被改回 'scanned' ——
 *    否则下一轮它会重新被判定成「未处理」，于是**重复回复 + 重复移除**。
 */
export function recordModScanned(db, post, extra = {}) {
  if (!db || !post?.id) return;
  const cur = getPost(db, post.id);
  const curStatus = String(cur?.status || '');
  const next = MOD_TERMINAL.has(curStatus) ? curStatus : extra.status || null;
  upsertPost(db, {
    id: String(post.id),
    url: post.url,
    title: post.title,
    author: post.author,
    authorId: post.authorId,
    board: extra.board || post.board || null,
    publishTime: post.publishTime,
    status: next,
    keyword: extra.keyword || null,
    inviteCode: extra.inviteCode || null,
    stage: extra.stage || cur?.stage || null,
    detail: extra.detail ? { ...extra.detail, normKey: post.normKey || null } : null,
  });
}

/** 记一次状态变化 + 一条事件流水 */
export function recordStatus(db, id, status, { stage = null, keyword = null, detail = null, kind = null } = {}) {
  if (!db || !id) return;
  updatePost(db, id, { status, stage, keyword });
  logEvent(db, id, kind || status, detail ? { ...detail, stage } : { stage });
}

/** 这个帖子是否已经处理过（库里有终态记录，或 state.json 里有） */
export function isHandled(db, state, id) {
  if (db && isPostDone(db, id)) return true;
  const p = state?.posts?.[String(id)];
  if (!p) return false;
  if (p.modTask?.removedAt || p.modTask?.manualOnly || p.modTask?.replyOnlyAt) return true;
  return p.status === STATUS.REPLIED || p.status === STATUS.PENDING;
}

/**
 * 把 state.json 里的老记录搬进 SQLite，然后从 state.json 里删掉
 *
 * 搬走的是「按当时判定算完、不再参与判定」的记录（已回复 / 无需回复 / 已移除）。
 * 仍需参与判定的（待回复、需人工）**留在 state.json** —— 判重还要用它们。
 *
 * @returns {{moved:number, kept:number}}
 */
export function archiveOldPosts(state, db, { olderThanDays = 45, now = Date.now() } = {}) {
  if (!db || !state?.posts) return { moved: 0, kept: 0 };
  const cut = now - olderThanDays * 86400000;
  const keepStatuses = new Set([STATUS.PENDING, STATUS.MANUAL]);
  let moved = 0;
  let kept = 0;

  for (const [id, p] of Object.entries(state.posts)) {
    if (!p || typeof p !== 'object') continue;
    if (keepStatuses.has(p.status)) {
      kept++;
      continue;
    }
    // 时间锚点：最后更新时间（没有就用帖子发布时间）
    const anchor = Date.parse(p.updatedAt || p.at || '') || Number(p.publishTime || 0) * 1000;
    if (!anchor || anchor >= cut) {
      kept++;
      continue;
    }
    upsertPost(db, {
      id: String(id),
      url: p.url,
      title: p.title,
      author: p.author,
      publishTime: p.publishTime,
      status: p.status,
      stage: p.modTask?.stage || null,
      keyword: p.modTask?.keyword || null,
      inviteCode: p.modTask?.inviteCode || null,
      // 保留原来的时间戳：不然一律变成「刚更新」，永远裁不掉
      firstSeen: anchor,
      updatedAt: anchor,
      detail: { normKey: p.normKey || null, reason: p.reason || null, archivedFrom: 'state.json' },
    });
    logEvent(db, id, 'archived', { from: 'state.json', status: p.status });
    delete state.posts[id];
    moved++;
  }
  return { moved, kept };
}

/** 导出给 CLI/报表用 */
export { openDb, upsertPost, updatePost, logEvent, getPost, listPosts, listEvents, stats, prunePosts };
