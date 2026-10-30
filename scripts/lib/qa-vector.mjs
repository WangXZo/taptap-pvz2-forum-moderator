// 答疑库向量检索（零依赖，可离线）
//
// 为什么换向量：
//   原来只有「关键词命中 + bigram dice」两把尺子（lib/qa.mjs 的 scoreEntry），
//   问法和关键词写得不一样就匹配不上 —— 「无尽卡波」对「无尽关卡卡住」这类同义表达很弱。
//   向量检索把问法/关键词/正文都变成向量，语义相近就能召回。
//
// 三条路径（会记录**实际用了哪条**，对应 taptap-hotspot-intel 的做法）：
//   1. char-tfidf —— 默认。中文按 2/3-gram 切词 + TF-IDF 加权 + 余弦相似度。
//                    纯 JS，不需要模型、不需要联网，中文短文本上比词袋稳。
//   2. dense     —— 可选。config.qa.vector.endpoint 指向一个 OpenAI 兼容的 embeddings 服务
//                    （如本地 BGE），请求 {model, input:[...]} → {data:[{embedding}]}。
//   3. fallback  —— dense 不可用/超时 → 退回 char-tfidf，并在结果里标明 path。
//
// 向量存 SQLite（qa_vec 表）：一条答疑一行，稀疏向量存 JSON。
// idf 不入库，查询时从全库向量现算 df（N=几十条，开销可忽略）——少一张表、少一处不一致。

import { loadVectors, saveVector, clearVectors } from './db.mjs';

/**
 * 向量格式版本
 * 格式一变（存归一化 → 存原始权重、加覆盖率等），老索引就作废了。
 * 索引里记这个版本号，不一致就重建。
 */
export const VEC_VERSION = '2';

const CJK = /[\u4e00-\u9fa5]/;

/** 归一化：去标点、空白，统一小写 */
export function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[【】\[\]（）()《》「」“”"'`~!@#$%^&*_+=|\\/<>?.,:;{}\[\]-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 切词：
 *   - ASCII 词（长度 ≥2）
 *   - 中文 2-gram 与 3-gram（短文本上比单字稳，比分词器轻）
 */
export function tokenize(text) {
  const t = normalizeText(text);
  const out = [];
  // ASCII / 数字词
  for (const m of t.matchAll(/[a-z0-9]{2,}/g)) out.push(m[0]);
  // 中文片段：抽出来再切 n-gram
  const cjkRuns = t.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    for (let i = 0; i < run.length - 2; i++) out.push(run.slice(i, i + 3));
  }
  return out;
}

/** 词频表 */
function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

/** L2 归一化后的稀疏向量（Map<token, weight>） */
function normalizeVec(vec) {
  let sum = 0;
  for (const w of vec.values()) sum += w * w;
  const norm = Math.sqrt(sum) || 1;
  const out = new Map();
  for (const [k, w] of vec) out.set(k, w / norm);
  return out;
}

/**
 * 建库：给每条答疑算一个向量，写进 SQLite
 * @param db
 * @param entries [{id, question, keywords, answer}]
 */
export function buildIndex(db, entries) {
  const docs = entries.map((e) => ({
    id: e.id,
    question: e.question,
    keywords: e.keywords || [],
    text: [e.question, ...(e.keywords || []), String(e.answer || '').slice(0, 200)].join(' '),
  }));

  // df（文档频率）
  const df = new Map();
  for (const d of docs) {
    for (const t of new Set(tokenize(d.text))) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = docs.length || 1;
  const idf = (t) => Math.log(1 + N / (1 + (df.get(t) || 0)));

  clearVectors(db);
  let saved = 0;
  for (const d of docs) {
    const tf = termFreq(tokenize(d.text));
    const vec = new Map();
    for (const [t, f] of tf) {
      const w = (1 + Math.log(f)) * idf(t);
      if (w > 0) vec.set(t, w);
    }
    // ⚠️ 存**未归一化**的权重：覆盖率（query 被文档覆盖了多少）要用真实权重比，
    //    归一化后没法算 min(qw, dw)。余弦在查询时现算归一化。
    const obj = Object.fromEntries([...vec.entries()].map(([k, v]) => [k, Number(v.toFixed(6))]));
    saveVector(db, {
      entryId: d.id,
      question: d.question,
      keywords: d.keywords,
      vec: obj,
      dim: Object.keys(obj).length,
    });
    saved++;
  }
  // 记版本号（格式变了就靠它触发重建）
  try {
    db.prepare('INSERT INTO qa_meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(
      'vec_version',
      VEC_VERSION
    );
  } catch {}
  return { entries: saved, tokens: df.size };
}

/** 索引的格式版本（没有记录 = 老索引，需要重建） */
export function indexVersion(db) {
  try {
    return db.prepare('SELECT v FROM qa_meta WHERE k=?').get('vec_version')?.v || null;
  } catch {
    return null;
  }
}

/** 从库里读回全部向量，并现算 idf */
export function loadCorpus(db) {
  const rows = loadVectors(db);
  const df = new Map();
  for (const r of rows) {
    const vec = JSON.parse(r.vec || '{}');
    for (const t of Object.keys(vec)) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = rows.length || 1;
  const idf = (t) => Math.log(1 + N / (1 + (df.get(t) || 0)));
  const docs = rows.map((r) => ({
    entryId: r.entry_id,
    question: r.question,
    keywords: String(r.keywords || '').split(',').filter(Boolean),
    vec: JSON.parse(r.vec || '{}'),
  }));
  return { docs, df, idf, N };
}

/** 余弦（两个已 L2 归一化的稀疏向量） */
export function cosine(a, b) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [k, w] of small) {
    const v = big.get(k);
    if (v) s += w * v;
  }
  return s;
}

/**
 * 查询覆盖率：这句提问有多少「被这条答疑解释掉」了
 *
 * 为什么不能只用余弦：提问很短（十几个 n-gram），文档很长（问法+关键词+答案上百个 token），
 * 余弦会被长文档的分母拖到 0.05 以下，短问法根本召不回来。
 * 覆盖率看的是「提问这一边被匹配掉多少」，对短问法友好得多。
 */
export function coverage(qvec, dvec) {
  let qsum = 0;
  for (const w of qvec.values()) qsum += w;
  if (!qsum) return 0;
  let hit = 0;
  const [small, big] = qvec.size <= dvec.size ? [qvec, dvec] : [dvec, qvec];
  for (const [k, w] of small) {
    const v = big.get(k);
    if (v) hit += Math.min(w, v);
  }
  return hit / qsum;
}

/**
 * 查询：返回 [{entryId, score}]，按相似度倒序
 * @param opts.dense 可选的稠密向量函数 async (texts)=>number[][]，用于 dense 路径
 */
export async function search(db, queryText, { topN = 5, dense = null, minScore = 0.05 } = {}) {
  const corpus = loadCorpus(db);
  if (!corpus.docs.length) return { results: [], path: 'empty' };

  let path = 'char-tfidf';
  let scores = null;

  if (dense) {
    try {
      const texts = [queryText, ...corpus.docs.map((d) => `${d.question} ${d.keywords.join(' ')}`)];
      const vecs = await dense(texts);
      if (Array.isArray(vecs) && vecs.length === texts.length) {
        const q = vecs[0];
        const norm = (v) => {
          const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
          return v.map((x) => x / n);
        };
        const qn = norm(q);
        scores = vecs.slice(1).map((v, i) => ({ entryId: corpus.docs[i].entryId, score: dot(qn, norm(v)) }));
        path = 'dense';
      }
    } catch (e) {
      path = 'char-tfidf(fallback)';
    }
  }

  if (!scores) {
    const tf = termFreq(tokenize(queryText));
    const qv = new Map();
    for (const [t, f] of tf) {
      const w = (1 + Math.log(f)) * corpus.idf(t);
      if (w > 0) qv.set(t, w);
    }
    const qn = normalizeVec(qv);
    scores = corpus.docs.map((d) => {
      const dv = new Map(Object.entries(d.vec));
      const cos = cosine(qn, normalizeVec(dv));
      const cov = coverage(qv, dv);
      return { entryId: d.entryId, score: Math.max(cos, cov) };
    });
  }

  const results = scores
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
  return { results, path };
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * (b[i] || 0);
  return s;
}

/**
 * 可选的 dense 后端：OpenAI 兼容的 embeddings 接口
 * @param endpoint 例如 http://127.0.0.1:8000/v1/embeddings
 */
export function makeHttpDense({ endpoint, model, apiKey = '', timeoutMs = 8000 } = {}) {
  if (!endpoint || !model) return null;
  return async (texts) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error(`dense ${r.status}`);
      const j = await r.json();
      const arr = (j?.data || []).sort((a, b) => (a.index || 0) - (b.index || 0)).map((x) => x.embedding);
      if (!arr.length) throw new Error('dense 无返回');
      return arr;
    } finally {
      clearTimeout(timer);
    }
  };
}
