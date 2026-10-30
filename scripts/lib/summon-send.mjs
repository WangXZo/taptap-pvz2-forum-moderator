// 发送一条「喊话互动」楼中楼回复
//
// 与 lib/praise-send.mjs 的关系：低层执行器都是 lib/reply-nested.mjs 的 replyToComment，
// 这里只多做两件事 —— ① 记「这条评论已经回应过」（防重复）② 记进 recentReplies（防重样）。
// 不和 praise-send 合并：两者的去重键不同（praisedComments / summonReplied），
// 混在一起会让「夸过」和「回应过」互相误伤。

import { replyToComment } from './reply-nested.mjs';
import { liteHash } from './util.mjs';

/**
 * @param {object} o
 * @param {object} o.state       状态库（会被就地更新）
 * @param {string} o.postId
 * @param {string} o.commentId   被回应的那条评论 ID
 * @param {string} o.url         帖子链接
 * @param {string} o.text        单行文案（含表情标记）
 * @param {object} o.runner      opencli runner
 * @param {Function} [o.log]
 * @returns {Promise<{ok:boolean, stage?:string, verified?:boolean, emoji?:string, detail?:any}>}
 */
export async function sendSummonReply({
  state,
  postId,
  commentId,
  url,
  text,
  runner,
  via = 'ui',
  log = () => {},
}) {
  const r = await replyToComment({
    runner,
    url,
    commentId: String(commentId),
    text,
    dryRun: false,
    // 楼中楼默认仍点 UI（接口 create-child 参数未实测确认，见 reply-nested.mjs 注释）
    via,
    log,
  });

  if (!r.ok) return { ok: false, stage: r.stage, detail: r.detail };

  const p = state.posts[postId];
  if (p) {
    p.summonReplied = [...new Set([...(p.summonReplied || []), String(commentId)])];
    p.summonAt = new Date().toISOString();
    p.summonPending = false;
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
    `    [OK] 已回应（表情 ${r.detail?.emoji || '-'}）` +
      (r.detail?.verified ? '（页面已核验到）' : '（浏览器已提交，页面未展开核验到）')
  );

  return { ok: true, verified: r.detail?.verified, emoji: r.detail?.emoji };
}
