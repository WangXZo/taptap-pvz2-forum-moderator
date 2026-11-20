// C1 事实层 facts（SQLite，2026-11-17 P0-M2）
// 结构化实体知识（植物/道具/关卡/活动/规则），与问答层(qa/答疑库.md)分离。
// 精确 lookup(name/alias) 秒答事实；带 provenance/置信/时效/多源佐证，供自治治理(C2)与分档验证(C7)。
// 零依赖：复用 db.mjs 的 node:sqlite 实例。

export const FACTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS facts(
  id TEXT PRIMARY KEY, name TEXT, type TEXT,
  aliases TEXT, attrs TEXT,
  provenance TEXT,
  validUntil INTEGER, status TEXT,
  createdAt INTEGER, updatedAt INTEGER);
CREATE TABLE IF NOT EXISTS fact_sources(factId TEXT, source TEXT, url TEXT, confidence INTEGER, at INTEGER);
CREATE TABLE IF NOT EXISTS fact_feedback(id INTEGER PRIMARY KEY AUTOINCREMENT, factId TEXT, type TEXT, player TEXT, postId TEXT, reason TEXT, resolved INTEGER DEFAULT 0, at INTEGER);
CREATE INDEX IF NOT EXISTS idx_facts_name ON facts(name);
CREATE INDEX IF NOT EXISTS idx_facts_type ON facts(type);
`;

export function initFacts(db) {
  db.exec(FACTS_SCHEMA);
}

const now = () => Date.now();
const J = (x) => JSON.stringify(x ?? null);
const P = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

export function addFact(db, f) {
  const id = f.id || String(f.name || '').trim();
  if (!id) return null;
  const t = now();
  db.prepare(
    `INSERT INTO facts(id,name,type,aliases,attrs,provenance,validUntil,status,createdAt,updatedAt)
     VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,aliases=excluded.aliases,
       attrs=excluded.attrs,provenance=excluded.provenance,validUntil=excluded.validUntil,
       status=excluded.status,updatedAt=excluded.updatedAt`
  ).run(
    id, f.name || id, f.type || 'rule', J(f.aliases || []), J(f.attrs || {}),
    J(f.provenance || { source: f.source || null, confidence: f.confidence ?? 50, verifiedAt: null, corroborations: 0 }),
    f.validUntil ?? null, f.status || 'active', f.createdAt ?? t, t
  );
  return id;
}

export function listFacts(db, { type, status } = {}) {
  let rows = db.prepare('SELECT * FROM facts').all();
  if (type) rows = rows.filter((r) => r.type === type);
  if (status) rows = rows.filter((r) => r.status === status);
  return rows.map((r) => ({ ...r, aliases: P(r.aliases, []), attrs: P(r.attrs, {}), provenance: P(r.provenance, {}) }));
}

/** 精确 lookup：name 或 alias 命中（归一化空白/大小写） */
export function lookupFact(db, name) {
  const q = String(name || '').replace(/\s+/g, '').toLowerCase();
  if (!q) return null;
  for (const f of listFacts(db)) {
    const names = [f.name, ...(f.aliases || [])].map((x) => String(x || '').replace(/\s+/g, '').toLowerCase());
    if (names.includes(q)) return f;
  }
  return null;
}

export function setFactStatus(db, id, status) {
  db.prepare('UPDATE facts SET status=?, updatedAt=? WHERE id=?').run(status, now(), id);
}

export function addSource(db, factId, { source, url, confidence }) {
  db.prepare('INSERT INTO fact_sources(factId,source,url,confidence,at) VALUES(?,?,?,?,?)')
    .run(factId, source || null, url || null, confidence ?? null, now());
}

export function sourcesOf(db, factId) {
  return db.prepare('SELECT * FROM fact_sources WHERE factId=?').all(factId);
}

export function addFeedback(db, factId, { type, player, postId, reason } = {}) {
  db.prepare('INSERT INTO fact_feedback(factId,type,player,postId,reason,resolved,at) VALUES(?,?,?,?,?,0,?)')
    .run(factId, type || 'confirm', player || null, postId || null, reason || null, Date.now());
}

export function feedbackStats(db, factId) {
  const rows = db.prepare('SELECT * FROM fact_feedback WHERE factId=?').all(factId);
  const confirms = rows.filter((r) => r.type === 'confirm').length;
  const neg = rows.filter((r) => r.type === 'negative' && !r.resolved);
  return { confirms, unresolvedNegative: neg.length, lastNegativeReason: neg[neg.length - 1]?.reason || null };
}

/** 动态置信校准（用户规格 2026-11-17）：
 *  官方/人工核实=95；负反馈未解决=30(待核实)；>3渠道且>=3玩家统一=80；>=2渠道一致=70；单一=50。 */
export function calibratedConfidence(db, fact) {
  if (!fact) return 50;
  const prov = fact.provenance || {};
  const srcs = sourcesOf(db, fact.id);
  // 官方判定三处都认：verifiedAt / provenance.source / fact_sources.source
  // （2026-11-17 P2 检查修：duel 事实 source=官方公告 但无 verifiedAt/sources 行 → 曾被误校准 50）
  const official = (s) => /官方|公告|official/.test(String(s || ''));
  if (prov.verifiedAt || official(prov.source) || srcs.some((s) => official(s.source))) return 95;
  const fb = feedbackStats(db, fact.id);
  if (fb.unresolvedNegative > 0) return 30;
  const channels = new Set(srcs.map((s) => s.source).filter(Boolean));
  if (channels.size > 3 && fb.confirms >= 3) return 80;
  if (channels.size >= 2) return 70;
  return 50;
}