// C3 增强（2026-11-17 P2 轮）：ollama bge-m3 真 embedding（本地免费，1024 维）。
// SQLite 缓存（key=sha1(model+text)）→ 库向量只算一次，每轮只嵌 query。
// 任一缺失/服务不可用 → 返回 null，调用方回退 char-ngram（不阻断）。
import { createHash } from 'node:crypto';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
const NUL = String.fromCharCode(0);

export function embedKey(model, text) {
  return createHash('sha1').update(model + NUL + String(text || '')).digest('hex');
}

/** 余弦相似度（纯函数，bge-m3 稠密路用） */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

export function initEmbedCache(db) {
  db.exec('CREATE TABLE IF NOT EXISTS dense_cache(key TEXT PRIMARY KEY, model TEXT, vec TEXT, at INTEGER)');
}

/**
 * 批量 embedding（ollama /api/embed，input 数组）。带 SQLite 缓存。
 * @returns {Promise<Array<Array<number>>|null>} 全齐返回向量数组；任一缺失返回 null（回退 char）。
 * fetchImpl 可注入（测试用）。
 */
export async function embedTexts(texts, { config = {}, log = () => {}, fetchImpl = null, cacheDb = null } = {}) {
  const list = (texts || []).map((t) => String(t || ''));
  if (!list.length) return [];
  const model = config?.retrieve?.embedModel || 'bge-m3';
  const endpoint = config?.retrieve?.embedEndpoint || DEFAULT_ENDPOINT;
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const out = new Array(list.length).fill(null);
  let miss = [];
  if (cacheDb) {
    initEmbedCache(cacheDb);
    const get = cacheDb.prepare('SELECT vec FROM dense_cache WHERE key=? AND model=?');
    list.forEach((t, i) => {
      const row = get.get(embedKey(model, t), model);
      if (row?.vec) { try { out[i] = JSON.parse(row.vec); } catch {} }
      if (!out[i]) miss.push(i);
    });
  } else {
    miss = list.map((_, i) => i);
  }
  if (miss.length) {
    try {
      const r = await doFetch(`${endpoint}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: miss.map((i) => list[i]) }),
        signal: AbortSignal.timeout(Number(config?.retrieve?.embedTimeoutMs ?? 30000)),
      });
      if (r.ok) {
        const j = await r.json();
        const embs = j?.embeddings || [];
        const put = cacheDb ? cacheDb.prepare('INSERT INTO dense_cache(key,model,vec,at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET vec=excluded.vec, model=excluded.model, at=excluded.at') : null;
        miss.forEach((i, k) => {
          if (Array.isArray(embs[k]) && embs[k].length) {
            out[i] = embs[k];
            if (put) put.run(embedKey(model, list[i]), model, JSON.stringify(embs[k]), Date.now());
          }
        });
      }
    } catch (e) {
      log(`  [embed] ollama 不可用（${e.message}）→ char 兜底`);
    }
  }
  return out.every((v) => Array.isArray(v) && v.length) ? out : null;
}