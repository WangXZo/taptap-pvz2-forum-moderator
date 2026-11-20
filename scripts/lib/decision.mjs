// v2 判定决策（O10，2026-11-19）：把 collect 里的「检索→验证→fact 被拒回退问答层」抽成纯逻辑，便于单测。
// 依赖注入 retrieveImpl / verifyImpl（默认用真实模块），行为与原 collect 内联版一致。
import * as retrieveMod from './retrieve.mjs';
import * as verifyMod from './verify.mjs';

/**
 * @param {object} o
 * @param {object} o.post
 * @param {Array}  o.qa
 * @param {object} o.db
 * @param {object} o.config
 * @param {object} [o.vecScores]
 * @param {Function} [o.log]
 * @param {Function} [o.retrieveImpl]
 * @param {Function} [o.verifyImpl]
 * @returns {Promise<{rr:object|null, v:object|null, usedFallback:boolean, stage:'hit'|'fallback'|'abstain'|'nomatch'}>}
 */
export async function decideV2({ post, qa, db, config = {}, vecScores = null, log = () => {}, retrieveImpl = null, verifyImpl = null } = {}) {
  const doRetrieve = retrieveImpl || retrieveMod.retrieve;
  const doVerify = verifyImpl || verifyMod.verifyCandidate;
  const minScore = Number(config?.match?.suggestScore ?? 0.45);

  let rr = await doRetrieve(post, { qa, db, config, vecScores, log });
  if (!rr?.entry || rr.score < minScore) {
    return { rr: null, v: null, usedFallback: false, stage: 'nomatch' };
  }
  let v = await doVerify(post, rr.entry, { config, log });

  // fact 不答该问被 judge 拒 → 回退问答层重检+重判（别弃整帖）
  if (!v.ok && rr.source === 'fact') {
    const r2 = await doRetrieve(post, { qa, db, config, vecScores, log, skipFacts: true });
    if (r2?.entry && r2.score >= minScore) {
      const v2 = await doVerify(post, r2.entry, { config, log });
      if (v2.ok) {
        log(`  [检索] fact 不答该问 → 回退问答层「${r2.entry.question}」`);
        return { rr: r2, v: v2, usedFallback: true, stage: 'fallback' };
      }
    }
  }
  if (v.ok) return { rr, v, usedFallback: false, stage: 'hit' };
  return { rr, v, usedFallback: false, stage: 'abstain' };
}