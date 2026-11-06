// 发送「互动续聊」回复（用户 2026-11-05）
//
// 与 lib/summon-send.mjs 的关系：底层执行器都是 lib/reply-nested.mjs 的 replyToComment，
// 但**记账键不同**，所以不合并：
//   · summon-send  → summonReplied（喊话通道）
//   · interact-send → interactReplied + interactCounts（互动续聊通道）
// 混在一起会让「喊过」和「续聊过」互相误伤（大哥要求：功能独立、降低耦合）。
//
// 回在哪一层由 lib/interact.mjs 的 replyTargetFor() 决定，这里只负责发 + 记账。

import { replyToComment } from './reply-nested.mjs';
import { liteHash } from './util.mjs';
import { bumpCount } from './interact.mjs';

/**
 * @param {object} o
 * @param {object} o.state      状态库（就地更新）
 * @param {string} o.postId
 * @param {string} o.commentId  触发互动的那条评论 ID（记账用）
 * @param {string} o.parentId   楼中楼挂在哪条评论下（replyTargetFor 给的）
 * @param {string} o.text       单行文案（含表情标记）
 * @param {string} o.url        帖子链接
 * @param {string} o.playerKey  计数键（作者 id / 昵称）
 * @param {object} o.runner     opencli runner
 * @param {string} [o.via]      'api' | 'ui'
 * @param {Function} [o.log]
 */
export async function sendInteractReply({
  state,
  postId,
  commentId,
  parentId,
  text,
  url,
  playerKey = '',
  runner,
  via = 'ui',
  log = () => {},
}) {
  if (!parentId) return { ok: false, stage: 'no_parent_id' };

  const r = await replyToComment({
    runner,
    url,
    commentId: String(parentId),
    text,
    dryRun: false,
    via,
    log,
  });

  if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail };

  const p = state.posts[postId];
  if (p) {
    // 这条评论已经回应过 → 不再重复
    p.interactReplied = [...new Set([...(p.interactReplied || []), String(commentId)])];
    p.interactAt = new Date().toISOString();
    // 同帖 × 同玩家累计次数（用来降概率）
    if (playerKey) p.interactCounts = bumpCount(p.interactCounts || {}, playerKey);
  }

  const h = liteHash(text);
  state.recentReplies = state.recentReplies || {};
  state.recentReplies[h] = {
    text,
    at: new Date().toISOString(),
    count: (state.recentReplies[h]?.count || 0) + 1,
    postId,
  };

  log(
    `    [OK] 已接话（表情 ${r.detail?.emoji || '-'}）` +
      (r.detail?.verified ? '（页面已核验到）' : '（浏览器已提交，页面未展开核验到）')
  );

  return { ok: true, verified: r.detail?.verified, emoji: r.detail?.emoji };
}
