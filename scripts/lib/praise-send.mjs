// 发送一条楼中楼夸奖（collect 与 post-admin recheck 共用）
//
// 为什么要抽出来：
//   常规流程在 collect.mjs 的 3b 阶段发；
//   但**旧帖子的错判**（规则改了、帖子已滑出扫描窗口）需要事后单独处理，
//   那条路径在 post-admin.mjs 的 recheck 子命令里 —— 两条路径共用一份实现，避免行为漂移。

import { replyToComment } from './reply-nested.mjs';
import { listComments } from './http.mjs';
import { liteHash } from './util.mjs';

/**
 * @param {object} o
 * @param {object} o.config
 * @param {object} o.state         状态库（会被就地更新）
 * @param {string} o.postId
 * @param {string} o.commentId     被夸的那条评论 ID
 * @param {string} o.url           帖子链接
 * @param {string} o.text          夸奖文案（含表情标记）
 * @param {object} o.runner        opencli runner
 * @param {Function} o.log
 * @returns {Promise<{ok:boolean, stage?:string, emoji?:string, verified?:boolean, detail?:any}>}
 */
export async function sendPraise({ config, state, postId, commentId, url, text, runner, log = () => {} }) {
  const r = await replyToComment({
    runner,
    url,
    commentId: String(commentId),
    text,
    dryRun: false,
    // 楼中楼默认仍点 UI（接口 create-child 参数未实测确认，见 reply-nested.mjs 注释）
    via: config?.reply?.nestedVia || 'ui',
    log,
  });

  if (!r.ok) {
    return { ok: false, stage: r.stage, detail: r.detail };
  }

  // 记账：这一帖夸过、这一条评论夸过
  if (state.posts[postId]) {
    state.posts[postId].praised = true;
    state.posts[postId].praisedAt = new Date().toISOString();
    state.posts[postId].praisedComments = [
      ...new Set([...(state.posts[postId].praisedComments || []), String(commentId)]),
    ];
  }

  // 记进「已发文本」，避免对不同玩家发一模一样的句子
  const h = liteHash(text);
  state.recentReplies = state.recentReplies || {};
  state.recentReplies[h] = {
    text,
    at: new Date().toISOString(),
    count: (state.recentReplies[h]?.count || 0) + 1,
    postId,
  };

  log(
    `    [OK] 已夸奖（表情 ${r.detail?.emoji || '-'}）` +
      (r.detail?.verified ? '（页面已核验到）' : '（浏览器已提交，页面未展开核验到）')
  );

  // 接口复核（仅参考，不作为判据）
  // ⚠️ 接口的 child_posts **不返回被折叠的楼中楼回复**，查不到不代表没发出去
  //    （实测：两条都发出去了，接口只看到折叠前的那几条）
  //    真正的判据是浏览器侧的「草稿已清空 + 页面里能搜到文案」。
  try {
    const cs = await listComments({ momentId: postId, from: 0, limit: 30 });
    const all = [];
    for (const c of cs.list || []) {
      all.push(c);
      for (const ch of c.child_posts || []) all.push(ch);
    }
    const probe = String(text).replace(/\s+/g, '').slice(0, 6);
    const uid = String(config.myUserId || '__none__');
    const hit = all.some(
      (c) =>
        String(c.author?.id || '') === uid &&
        String(c.contents?.json?.[0]?.children?.[0]?.text || '')
          .replace(/\s+/g, '')
          .includes(probe)
    );
    log(`    [参考] 接口可见范围内${hit ? '能查到' : '查不到'}（折叠的回复接口不返回，不作判据）`);
  } catch (e) {
    log(`    [参考] 接口复核失败：${e.message}`);
  }

  return { ok: true, emoji: r.detail?.emoji, verified: r.detail?.verified };
}
