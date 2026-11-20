// C3 混合检索（2026-11-17 P1）：BM25(关键词) + dense(语义) 双路召回 + RRF 融合 → top-K。
// dense 默认 char-ngram coverage（零依赖）；传入 dense={q,docs}（bge-m3 真 embedding，见 embed.mjs）→ 余弦。
import { bm25Scores } from './bm25.mjs';
import { sparseVector, coverage } from './qa-vector.mjs';
import { cosine } from './embed.mjs';

/** Reciprocal Rank Fusion：score(d)=Σ 1/(k+rank)，只用排名不用原始分（跨路可比）。 */
export function rrf(rankLists, k = 60) {
  const score = new Map();
  for (const list of rankLists) {
    list.forEach((id, rank) => score.set(id, (score.get(id) || 0) + 1 / (k + rank + 1)));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id, s]) => ({ id, score: s }));
}

export function hybridSearch(qa, queryText, { topK = 8, dense = null } = {}) {
  if (!qa?.length) return [];
  const docs = qa.map((e) => [e.question, (e.keywords || []).join(' '), e.answer].join(' '));
  const bm = bm25Scores(docs, queryText);
  const toMap = (o) => new Map(Object.entries(o));
  // dense 路：bge-m3 真 embedding 余弦（dense={q,docs} 与 qa 同序）；缺省/不齐 → char-ngram coverage
  const useDense = dense && Array.isArray(dense.q) && Array.isArray(dense.docs) && dense.docs.length === qa.length;
  const qv = useDense ? null : toMap(sparseVector(queryText));
  const dn = useDense
    ? qa.map((e, i) => Math.max(0, cosine(dense.q, dense.docs[i])))
    : qa.map((e) => coverage(qv, toMap(sparseVector([e.question, (e.keywords || []).join(' ')].join(' ')))));
  const bmRank = bm.map((s, i) => ({ i, s })).sort((a, b) => b.s - a.s).map((x) => x.i);
  const dnRank = dn.map((s, i) => ({ i, s })).sort((a, b) => b.s - a.s).map((x) => x.i);
  const fused = rrf([bmRank, dnRank]); // RRF 决定顺序
  const maxBm = Math.max(...bm, 1e-9);
  // 分值归一化到 0-1（供 autoReplyScore/suggestScore 阈值）：0.6*BM25归一 + 0.4*dense
  return fused.slice(0, topK).map(({ id }) => ({
    entry: qa[id],
    score: 0.6 * (bm[id] / maxBm) + 0.4 * dn[id],
    bm25: bm[id],
    dense: dn[id],
  }));
}