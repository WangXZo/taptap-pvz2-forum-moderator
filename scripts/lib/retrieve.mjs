// P0-M6 检索抽象（v2 管线）：facts 精确 lookup 优先 + 问答层 hybrid(BM25+dense)+RRF+rerank。
// 返回 {source:'fact'|'qa', entry, score, candidates}。entry 统一含 question/answer/confidence。
// candidates 带 entry（P2 C6 结构化组装要多候选合成）。调用方不变。
import { resolve } from 'node:path';
import { listFacts, lookupFact, calibratedConfidence } from './facts.mjs';
import { hybridSearch } from './hybrid.mjs';
import { rerank } from './rerank.mjs';
import { rewriteQuery } from './intent.mjs';
import { embedTexts } from './embed.mjs';
import { openDb } from './db.mjs';
import { SKILL_ROOT } from './paths.mjs';

function attrsToText(f) {
  return Object.entries(f.attrs || {}).map(([k, v]) => `${k}：${v}`).join('；');
}

/** fact 命中统一出口（C8 实体路由 / 文本提及共用）；viaEntity 标记来源供观测 */
function factResult(db, f, via) {
  const confidence = calibratedConfidence(db, f);
  const entry = {
    id: f.id, question: f.name, name: f.name, answer: attrsToText(f), confidence,
    attrs: f.attrs, provenance: f.provenance, status: f.status, source: 'fact', semanticConfirm: true,
    viaEntity: via === 'entity',
  };
  return {
    source: 'fact',
    entry,
    score: 1,
    candidates: [{ qaId: f.id, question: f.name, score: 1, source: 'fact', entry }],
  };
}

export async function retrieve(post, { qa, db, config, vecScores = null, log = () => {}, skipFacts = false } = {}) {
  const text = rewriteQuery(post, { db }); // C5 别名展开+去表情，提升召回
  // C8 多模态实体路由：图片模板实体 → facts 精确 lookup 直连（优先于文本提及）；
  // 误识别兜底 = 调用方 C7 verifyCandidate（judge 不达标弃答）。
  // skipFacts：fact 被 judge 拒后回退问答层重检（fact 不答该问时别弃整帖）。
  if (db && !skipFacts) {
    for (const ent of post?.imageEntities || []) {
      const f = lookupFact(db, ent);
      if (f && f.status === 'active') return factResult(db, f, 'entity');
    }
    // facts：name/alias 提及命中（active）；**最长匹配优先**（防泛别名「无尽」遮蔽专名「摇滚无尽」）。
    // 用**原文**而非 rewrite 后的 text：别名展开会把「摇滚无尽」扩成「摇滚无尽 无尽挑战」造成泛名同长遮蔽。
    const raw = `${post?.title || ''} ${post?.text || ''} ${post?.imageText || ''}`;
    let best = null;
    let bestLen = 0;
    for (const f of listFacts(db, { status: 'active' })) {
      for (const n of [f.name, ...(f.aliases || [])].filter(Boolean)) {
        if (raw.includes(n) && n.length > bestLen) { best = f; bestLen = n.length; }
      }
    }
    if (best) return factResult(db, best, 'text');
  }
  // C3 增强：bge-m3 真 embedding（SQLite 缓存，库向量只算一次）；不可用 → char-ngram 兜底
  let dense = null;
  if (config?.retrieve?.denseBackend !== 'char' && qa?.length) {
    try {
      const cacheDb = openDb(resolve(SKILL_ROOT, 'data/dense-cache.sqlite'));
      const docTexts = qa.map((e) => [e.question, (e.keywords || []).join(' '), String(e.answer || '').slice(0, 200)].join(' '));
      const vecs = await embedTexts([...docTexts, text], { config, cacheDb, log });
      if (vecs) dense = { q: vecs[vecs.length - 1], docs: vecs.slice(0, -1) };
    } catch {
      dense = null;
    }
  }
  // C3 混合检索 + C4 重排（v2）
  let cands = hybridSearch(qa || [], text, { topK: Number(config?.retrieve?.topK ?? 8), dense });
  if (config?.retrieve?.rerank !== false && cands.length > 1) {
    cands = await rerank(text, cands, { config, log });
  }
  const top = cands[0];
  const minScore = Number(config?.retrieve?.minScore ?? 0.2);
  return {
    source: 'qa',
    entry: top && top.score >= minScore ? { ...top.entry, source: 'qa' } : null,
    score: top?.score || 0,
    candidates: cands.map((c) => ({ qaId: c.entry.id, question: c.entry.question, score: Number((c.score || 0).toFixed(3)), source: 'qa', entry: c.entry })),
  };
}