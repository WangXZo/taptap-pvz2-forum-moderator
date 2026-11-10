// 加好友帖「已回复指纹」（用户 2026-11-06）
//
// 为什么需要：`state.posts[id].modTask.repliedAt` 只能防「同一进程」重复回复。
// 万一出现两个 mod-watch（清锁窗口竞态 / 外部再拉起一份），两边各持一份 state，
// 就会**同一帖回两遍** —— 玩家看到两条一模一样的提醒。
//
// 做法：每帖一个 flag 文件，用 `wx`（O_EXCL）**原子创建**来抢锁：
//   · 创建成功 = 我抢到 → 可以发
//   · 已存在   = 别人在发/已发过 → 跳过
// 原子创建是文件系统层面保证的，跨进程可靠（比读-判断-写安全，没有窗口期）。
//
// flag 目录：data/replied/<momentId>.flag（内容是 pid + 时间，便于排查）

import { open, unlink, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function flagPath(dataDir, momentId) {
  return resolve(String(dataDir || 'data'), 'replied', `${String(momentId)}.flag`);
}

/**
 * 抢占「这条帖的回复权」
 *
 * @param {object} o
 * @param {string} o.dataDir
 * @param {string} o.momentId
 * @param {boolean} [o.force] 忽略已有 flag（人工强制重发时用）
 * @returns {Promise<{ok:boolean, reason?:string, file:string}>}
 */
export async function claimReply({ dataDir, momentId, force = false } = {}) {
  const file = flagPath(dataDir, momentId);
  try {
    await mkdir(dirname(file), { recursive: true });
  } catch {
    /* 目录建不了就直接试创建 */
  }
  if (force) {
    try {
      await unlink(file);
    } catch {}
  }
  try {
    // 'wx' = 只在不存在时创建，原子操作
    const fh = await open(file, 'wx');
    await fh.writeFile(`${process.pid}\t${new Date().toISOString()}\n`, 'utf8');
    await fh.close();
    return { ok: true, file };
  } catch (e) {
    if (e?.code === 'EEXIST') return { ok: false, reason: 'already_claimed', file };
    // 其它错误（权限等）→ 保守放行，但不能静默
    return { ok: true, reason: `claim_error:${e?.code || e?.message}`, file };
  }
}

/** 判断这帖是否已经被回复过（不抢占） */
export async function hasReplied({ dataDir, momentId } = {}) {
  try {
    const fh = await open(flagPath(dataDir, momentId), 'r');
    await fh.close();
    return true;
  } catch {
    return false;
  }
}

/** 释放（回复失败时回滚，允许下次重试） */
export async function releaseReply({ dataDir, momentId } = {}) {
  try {
    await unlink(flagPath(dataDir, momentId));
    return true;
  } catch {
    return false;
  }
}