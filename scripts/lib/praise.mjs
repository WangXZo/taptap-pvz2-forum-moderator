// 挑「值得夸的那条回答」（2026-11-04 精简）
//
// 这一文件原来负责两件事：① 挑对象 ② 组文案。
// 用户 2026-11-04 明确要求「模板不要用了」→ 文案改由 LLM 按三层上下文生成
// （见 lib/compose-reply.mjs 的 kind='praise'），所以这里**只留挑对象**。
//
// 挑对象的规矩不变（这几条是内容判断，不是模板）：
//  1) 只夸「有效回答」—— 复用 summarize 的噪音过滤与打分，避免夸到「顶/同问/哈哈哈」
//  2) 不夸版主/自己 —— 夸同行没意义，夸自己更奇怪
//  3) 一次只夸一条（同一条回答只夸一次）

import { flattenReplies, isNoise, isUsefulAnswer, scoreReply, tidy } from './summarize.mjs';

/**
 * 从评论树里挑出「最值得夸的那条回答」
 * @param {Array} comments 接口返回的一级评论列表（含 child_posts）
 * @param {{myUserId?:string, minScore?:number}} opts
 * @returns {null | {targetCommentId:string, author:string, authorId:string, text:string, score:number, isNested:boolean}}
 */
export function pickPraiseTarget(comments, { myUserId = '', minScore = 1 } = {}) {
  const uid = String(myUserId || '__none__');
  const list = flattenReplies(comments).filter((r) => r.authorId && r.authorId !== uid);
  if (!list.length) return null;

  const candidates = list
    .filter((r) => !isNoise(r))
    .filter((r) => isUsefulAnswer(r)) // 客服引导/私下交换/纯反问/贴码 → 不夸
    .filter((r) => !r.isModerator) // 不夸版主（含自己在答疑组）
    .map((r) => ({ ...r, score: scoreReply(r), clean: tidy(r.text) }))
    .filter((r) => r.clean.length >= 6)
    .sort((a, b) => b.score - a.score || b.time - a.time);

  const best = candidates[0];
  if (!best || best.score < minScore) return null;

  return {
    // 夸奖要按在它所属的一级评论下（浏览器可点的回复档只有一级）
    targetCommentId: String(best.parentId || best.id),
    author: best.author,
    authorId: best.authorId,
    text: best.clean,
    score: best.score,
    isNested: !!best.parentId,
    isRootAnswer: String(best.parentId || best.id) === String(best.id),
  };
}
