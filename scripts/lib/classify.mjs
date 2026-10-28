// 核心判定：把一条帖子归入四类之一
//
// 判定顺序（先命中先返回）：
//   1. 我回复过                    → replied  (already_replied)
//   2. 社区里其他人已回复          → replied  (others_replied)  ← 不重复答，答案沉淀进答疑库
//   3. 不是提问帖                  → no_need  (not_question)
//   4. 与已处理问题重复            → no_need  (duplicate)
//   5. 含敏感词                    → manual   (sensitive)
//   6. 命中但分数不够              → manual   (low_confidence)
//   7. 命中高置信 QA               → pending
//   8. 像提问但没命中              → manual   (no_qa_match)

import { STATUS, REASON, normKey } from './state.mjs';
import { matchPost, looksLikeQuestion } from './qa.mjs';
import { buildReplyText } from './variants.mjs';

export function classify(post, { qa, config, state }) {
  const text = post.text || '';

  // 1. 我回复过
  if (post.iReplied) return mk(STATUS.REPLIED, REASON.ALREADY_REPLIED);

  // 2. 其他人已回复 → 不重复答（答案会被沉淀进答疑库）
  if (post.othersReplied) {
    return mk(STATUS.REPLIED, REASON.OTHERS_REPLIED, {
      note: `${post.replyCount || ''} 条他人回复`.trim(),
    });
  }

  // 3. 非提问
  if (!looksLikeQuestion(text)) return mk(STATUS.NO_NEED, REASON.NOT_QUESTION);

  // 4. 重复问题
  const key = normKey(post.title) || normKey(text);
  if (key.length >= 4) {
    const dup = Object.entries(state.posts).find(
      ([id, p]) =>
        id !== post.id &&
        p.normKey &&
        p.normKey === key &&
        (p.status === STATUS.REPLIED || p.status === STATUS.NO_NEED || p.status === STATUS.PENDING)
    );
    if (dup) return mk(STATUS.NO_NEED, REASON.DUPLICATE, { duplicateOf: dup[0] });
  }

  // 5. 敏感词
  const black = (config.reply.blacklistWords || []).find((w) => text.includes(w));
  if (black) return mk(STATUS.MANUAL, REASON.SENSITIVE, { note: `含「${black}」` });

  // 6/7. QA 匹配
  const cands = matchPost(text, qa, 3);
  const top = cands[0];
  const candidates = cands.map((c) => ({
    qaId: c.entry.id,
    question: c.entry.question,
    score: Number(c.score.toFixed(3)),
    auto: !!c.entry.auto,
  }));

  if (top && top.score >= config.match.autoReplyScore) {
    return mk(STATUS.PENDING, null, {
      matchedEntry: top.entry,
      score: Number(top.score.toFixed(3)),
      candidates,
    });
  }
  if (top && top.score >= config.match.suggestScore) {
    return mk(STATUS.MANUAL, REASON.LOW_CONFIDENCE, {
      matchedEntry: top.entry,
      score: Number(top.score.toFixed(3)),
      candidates,
    });
  }

  // 8. 像提问但没命中
  return mk(STATUS.MANUAL, REASON.NO_QA_MATCH, { candidates });
}

function mk(status, reason, extra = {}) {
  return {
    status,
    reason: reason || null,
    matchedEntry: extra.matchedEntry || null,
    score: extra.score ?? 0,
    candidates: extra.candidates || [],
    note: extra.note || '',
    duplicateOf: extra.duplicateOf || null,
  };
}

/**
 * 组装最终回复文本
 * 签名优先级：QA 条目自带「签名:」 > config.reply.signature > 不加
 * 签名单独成段，追加在正文末尾（表情标记若在正文末尾，会排在签名之前）
 *
 * 变体：同一份答案不原样重复发 —— 用不同的「说法外壳」包同一份答案，
 * 并避开已经发过的文本（usedTexts 来自状态库）。事实来源仍然只有答疑库本身。
 */
export function composeReply(entry, config, { postId = '', usedTexts = [] } = {}) {
  const sig = (entry.signature ?? config.reply.signature ?? '').trim();
  const { text, opener, closer, duplicated } = buildReplyText({
    answer: entry.answer.trim(),
    postId,
    usedTexts,
    signature: sig,
    allowCloser: config.reply?.allowCloser !== false,
  });
  return { text, opener, closer, duplicated };
}
