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

export function classify(post, { qa, config, state, vecScores = null, matchPath = null }) {
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
  const cands = matchPost(text, qa, 3, { vecScores });
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
      matchPath,
    });
  }
  if (top && top.score >= config.match.suggestScore) {
    return mk(STATUS.MANUAL, REASON.LOW_CONFIDENCE, {
      matchedEntry: top.entry,
      score: Number(top.score.toFixed(3)),
      candidates,
      matchPath,
    });
  }

  // 8. 像提问但没命中
  return mk(STATUS.MANUAL, REASON.NO_QA_MATCH, { candidates, matchPath });
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
    matchPath: extra.matchPath || null,
  };
}

/**
 * ⚠️ 模板版组装（2026-11-04 已删）
 *
 * 原来这里是「答疑库答案 + 变体外壳（6 开头 × 4 收尾）」拼出来的回复。
 * 用户 2026-11-04 明确要求：**模板不要用了、不可僵硬抽取资料做答**，
 * 回复改由 LLM 按三层树状上下文生成（lib/compose-reply.mjs），
 * 答疑库命中只作为「参考资料」喂进去（condenseMaterial 先按话题挑相关句）。
 *
 * 所以这个函数已经删掉。需要生成回复 → 用 composeReply()（lib/compose-reply.mjs）。
 */
