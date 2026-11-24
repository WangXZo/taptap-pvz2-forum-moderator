// C4 重排（2026-11-17 P1）：top-K 精排。
// backend=onnx → 本地 cross-encoder(bge-reranker-v2-m3，rerank_server /rerank，设计首选)；
// backend=llm(默认过渡) → LLM listwise（RankGPT-lite）。失败逐级回退：onnx→llm→RRF 原序（不阻断）。
import { chat } from './llm.mjs';

export async function rerank(query, candidates, { config = {}, log = () => {} } = {}) {
  if (!candidates?.length || candidates.length <= 1) return candidates || [];
  if (config?.rerank?.backend === 'onnx') {
    try {
      const server = config.rerank.server || 'http://127.0.0.1:8790';
      const r = await fetch(`${server}/rerank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          candidates: candidates.map((c) => c.entry?.question || c.entry?.name || ''),
          modelDir: config.rerank.modelDir || '',
        }),
        signal: AbortSignal.timeout(Number(config.rerank.timeoutMs ?? 20000)),
      });
      if (r.ok) {
        const j = await r.json();
        if (j?.ok && Array.isArray(j.scores) && j.scores.length === candidates.length) {
          log(`  [rerank] onnx ${candidates.length} 候选精排完成`);
          return candidates.map((c, i) => ({ c, s: j.scores[i] })).sort((a, b) => b.s - a.s).map((x) => x.c);
        }
      }
      log('  [rerank] onnx 返回异常 → LLM listwise');
    } catch (e) {
      log(`  [rerank] onnx 不可用（${e.message}）→ LLM listwise`);
    }
  }
  const list = candidates.map((c, i) => `${i}: ${c.entry?.question || c.entry?.name || ''}`).join('\n');
  const r = await chat(config, {
    system: '按与玩家问题的相关性对候选排序（最相关在前）。只输出 JSON 索引数组，如 [2,0,1]。',
    messages: [{ role: 'user', content: `玩家问题：${query}\n候选：\n${list}\n输出索引数组。` }],
    temperature: 0, maxTokens: 100, timeoutMs: 20000, log,
  });
  if (!r.ok) return candidates;
  try {
    const idx = JSON.parse(String(r.text).replace(/```json|```/g, '').trim());
    if (Array.isArray(idx)) {
      const out = idx.map((i) => candidates[i]).filter(Boolean);
      for (const c of candidates) if (!out.includes(c)) out.push(c);
      return out;
    }
  } catch { /* 解析失败回退 */ }
  return candidates;
}