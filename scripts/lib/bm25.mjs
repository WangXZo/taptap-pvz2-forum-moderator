// C3 BM25（Okapi，纯 JS 零依赖，2026-11-17 P1）：关键词路召回，补精确词/标识符。
import { tokenize } from './qa-vector.mjs';

export function bm25Scores(docs, query, { k1 = 1.3, b = 0.9 } = {}) {
  const docTokens = docs.map((d) => tokenize(d));
  const qTokens = tokenize(query);
  const N = docTokens.length;
  const avgdl = docTokens.reduce((a, t) => a + t.length, 0) / Math.max(1, N);
  const df = {};
  for (const t of docTokens) for (const w of new Set(t)) df[w] = (df[w] || 0) + 1;
  return docTokens.map((t) => {
    const tf = {};
    for (const w of t) tf[w] = (tf[w] || 0) + 1;
    let s = 0;
    for (const w of qTokens) {
      const f = tf[w] || 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df[w] || 0) + 0.5) / ((df[w] || 0) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (t.length / Math.max(1, avgdl)))));
    }
    return s;
  });
}