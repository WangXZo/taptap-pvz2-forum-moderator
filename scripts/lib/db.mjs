// SQLite 存储层（Node 内置 node:sqlite，零依赖）
//
// 为什么上 SQLite：
//   1) **逐行写**，不像 state.json 那样每次改一条记录就重写整个文件（几十 KB～几百 KB）
//   2) **多进程互不覆盖** —— 之前 QA 守护与管理任务各写一份 state.json，
//      后写的把先写的冲掉（实测丢过 172 条移除记录）。SQLite 有 WAL + 事务，两个进程各写各的行。
//   3) 可查询、可裁剪、可归档（报告里要「最近 N 条」「某个状态有多少条」这类统计时不用全量读 JSON）
//
// ⚠️ node:sqlite 的坑：
//   - 参数只接受 null / number / bigint / string / Uint8Array，**布尔值不行** → 统一转 0/1
//   - Node ≥ 22.5 才有（24.x 稳定）；本机 24.18 可用
//   - 要开 WAL 才能多进程并发写

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS post_record (
  id           TEXT PRIMARY KEY,
  url          TEXT,
  title        TEXT,
  author       TEXT,
  author_id    TEXT,
  board        TEXT,
  publish_time INTEGER,
  status       TEXT,        -- 管理任务的状态（detected/replied/removed/manual_remove/failed）
  qa_status    TEXT,        -- 答疑守护的判定（pending/replied/no_need/manual）
  keyword      TEXT,
  invite_code  TEXT,
  stage        TEXT,
  reply_text   TEXT,
  first_seen   INTEGER,
  updated_at   INTEGER,
  detail       TEXT
);

CREATE TABLE IF NOT EXISTS post_event (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id TEXT,
  ts      INTEGER,
  kind    TEXT,
  detail  TEXT
);

CREATE TABLE IF NOT EXISTS qa_vec (
  entry_id  TEXT PRIMARY KEY,
  question  TEXT,
  keywords  TEXT,
  vec       TEXT,
  dim       INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS qa_meta (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_post ON post_event(post_id);
CREATE INDEX IF NOT EXISTS idx_event_ts ON post_event(ts);
CREATE INDEX IF NOT EXISTS idx_post_status ON post_record(status);
`;

/** 打开（并初始化）数据库 */
export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/**
 * 轻量迁移：给**已存在**的表补上缺失的列
 *
 * 为什么需要：CREATE TABLE IF NOT EXISTS 对老库**不会**加新列，
 * 老库 + 新代码 = 每次查询都报 "no such column"。
 * 这里补齐缺的列，老数据原样保留。
 */
function migrate(db) {
  const expected = {
    post_record: [
      'url', 'title', 'author', 'author_id', 'board', 'publish_time', 'status',
      'qa_status', 'keyword', 'invite_code', 'stage', 'reply_text', 'first_seen',
      'updated_at', 'detail',
    ],
  };
  for (const [table, cols] of Object.entries(expected)) {
    let have = [];
    try {
      have = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
    } catch {
      continue;
    }
    if (!have.length) continue;
    for (const c of cols) {
      if (have.includes(c)) continue;
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} TEXT`);
      } catch {}
    }
  }
}

/** node:sqlite 不收布尔值，统一转 0/1 */
const bit = (v) => (v ? 1 : 0);

/**
 * 写/更新一条帖子记录
 * @param rec {id,url,title,author,authorId,board,publishTime,status,keyword,inviteCode,stage,replyText,detail}
 */
export function upsertPost(db, rec) {
  if (!rec?.id) throw new Error('upsertPost 缺 id');
  const now = Date.now();
  // 搬库来的记录要**保留原时间戳**（否则一律变成「刚更新」，永远裁不掉）
  const firstSeen = Number(rec.firstSeen) || now;
  const updatedAt = Number(rec.updatedAt) || now;
  db.prepare(
    `INSERT INTO post_record
       (id,url,title,author,author_id,board,publish_time,status,qa_status,keyword,invite_code,stage,reply_text,first_seen,updated_at,detail)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       url=excluded.url, title=excluded.title, author=excluded.author, author_id=excluded.author_id,
       board=COALESCE(excluded.board, post_record.board),
       publish_time=excluded.publish_time,
       status=COALESCE(excluded.status, post_record.status),
       qa_status=COALESCE(excluded.qa_status, post_record.qa_status),
       keyword=COALESCE(excluded.keyword, post_record.keyword),
       invite_code=COALESCE(excluded.invite_code, post_record.invite_code),
       stage=COALESCE(excluded.stage, post_record.stage),
       reply_text=COALESCE(excluded.reply_text, post_record.reply_text),
       first_seen=MIN(post_record.first_seen, excluded.first_seen),
       updated_at=excluded.updated_at,
       detail=COALESCE(excluded.detail, post_record.detail)`
  ).run(
    String(rec.id),
    rec.url ?? null,
    rec.title ?? null,
    rec.author ?? null,
    rec.authorId ? String(rec.authorId) : null,
    rec.board ?? null,
    Number(rec.publishTime) || null,
    rec.status ?? null,
    rec.qaStatus ?? null,
    rec.keyword ?? null,
    rec.inviteCode ?? null,
    rec.stage ?? null,
    rec.replyText ?? null,
    firstSeen,
    updatedAt,
    rec.detail ? JSON.stringify(rec.detail) : null
  );
}

/** 只更新状态类字段（值为 null/undefined 的字段**不覆盖**已有值） */
export function updatePost(db, id, fields) {
  const allowed = ['status', 'qa_status', 'stage', 'keyword', 'invite_code', 'reply_text', 'detail'];
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields || {})) {
    const col =
      allowed.includes(k)
        ? k
        : k === 'inviteCode'
          ? 'invite_code'
          : k === 'replyText'
            ? 'reply_text'
            : k === 'qaStatus'
              ? 'qa_status'
              : null;
    if (!col) continue;
    if (v === null || v === undefined) continue; // 不传就别动已有字段
    sets.push(`${col}=?`);
    vals.push(typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  if (!sets.length) return;
  sets.push('updated_at=?');
  vals.push(Date.now(), String(id));
  db.prepare(`UPDATE post_record SET ${sets.join(', ')} WHERE id=?`).run(...vals);
}

/** 记一条事件（追加写，不覆盖） */
export function logEvent(db, postId, kind, detail = null) {
  db.prepare('INSERT INTO post_event (post_id, ts, kind, detail) VALUES (?,?,?,?)').run(
    String(postId),
    Date.now(),
    String(kind),
    detail ? JSON.stringify(detail) : null
  );
}

/** 读一条记录 */
export function getPost(db, id) {
  const r = db.prepare('SELECT * FROM post_record WHERE id=?').get(String(id));
  return r || null;
}

/** 这条帖子是否已经「处理完」（回复过或已移除或留人工） */
export function isPostDone(db, id) {
  const r = getPost(db, id);
  if (!r) return false;
  return ['replied', 'removed', 'manual_remove', 'failed'].includes(String(r.status));
}

/** 列出记录（按时间倒序） */
export function listPosts(db, { limit = 100, status = null } = {}) {
  const sql = status
    ? 'SELECT * FROM post_record WHERE status=? ORDER BY updated_at DESC LIMIT ?'
    : 'SELECT * FROM post_record ORDER BY updated_at DESC LIMIT ?';
  return status ? db.prepare(sql).all(String(status), Number(limit)) : db.prepare(sql).all(Number(limit));
}

/** 某帖的事件流水 */
export function listEvents(db, postId, limit = 50) {
  return db
    .prepare('SELECT * FROM post_event WHERE post_id=? ORDER BY id DESC LIMIT ?')
    .all(String(postId), Number(limit));
}

/** 统计 */
export function stats(db) {
  const total = db.prepare('SELECT COUNT(*) c FROM post_record').get()?.c ?? 0;
  const byStatus = db.prepare('SELECT status, COUNT(*) c FROM post_record GROUP BY status').all();
  const events = db.prepare('SELECT COUNT(*) c FROM post_event').get()?.c ?? 0;
  return { total, events, byStatus: Object.fromEntries(byStatus.map((r) => [r.status || 'none', r.c])) };
}

/** 裁剪：把老记录（按 updated_at）挪进事件流水后从主表删掉，保持主表轻 */
export function prunePosts(db, { olderThanDays = 60, keepStatuses = ['failed', 'manual_remove'] } = {}) {
  const cut = Date.now() - olderThanDays * 86400000;
  const keep = (keepStatuses || []).filter(Boolean);
  // keepStatuses 为空时不能拼 `NOT IN ()`（SQL 语法错误）→ 分成两种 SQL
  const sql = keep.length
    ? `SELECT * FROM post_record WHERE updated_at < ? AND status NOT IN (${keep.map(() => '?').join(',')})`
    : 'SELECT * FROM post_record WHERE updated_at < ?';
  const rows = keep.length ? db.prepare(sql).all(cut, ...keep) : db.prepare(sql).all(cut);
  if (!rows.length) return { pruned: 0 };
  const ins = db.prepare('INSERT INTO post_event (post_id, ts, kind, detail) VALUES (?,?,?,?)');
  for (const r of rows) {
    ins.run(r.id, r.updated_at, 'pruned', JSON.stringify({ status: r.status, stage: r.stage, title: r.title }));
  }
  const del = db.prepare('DELETE FROM post_record WHERE id=?');
  for (const r of rows) del.run(r.id);
  return { pruned: rows.length };
}

/** 存取答疑条目的向量 */
export function saveVector(db, { entryId, question, keywords, vec, dim }) {
  db.prepare(
    `INSERT INTO qa_vec (entry_id, question, keywords, vec, dim, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(entry_id) DO UPDATE SET question=excluded.question, keywords=excluded.keywords,
       vec=excluded.vec, dim=excluded.dim, updated_at=excluded.updated_at`
  ).run(
    String(entryId),
    String(question || ''),
    String((keywords || []).join(',')),
    JSON.stringify(vec),
    Number(dim) || 0,
    Date.now()
  );
}

export function loadVectors(db) {
  return db.prepare('SELECT entry_id, question, keywords, vec FROM qa_vec').all();
}

export function clearVectors(db) {
  db.prepare('DELETE FROM qa_vec').run();
}
