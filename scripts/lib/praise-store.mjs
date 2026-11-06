// 夸奖文案的向量沉淀（用户 2026-11-02）
//
// 要求原话：「夸奖，要求按照自己性格，回复。自行思考编辑对话内容。可以参考示例，
//            但不建议多次直接使用。可以自动沉淀，相关内容（向量数据库）。」
//
// 做法：
//   每次夸完，把「被夸的那条回答 ↔ 我们说的夸奖」成对存进 SQLite（praise_reply 表），
//   并记一份字符 n-gram 的稀疏向量（和答疑库向量检索同一套算法，见 lib/qa-vector.mjs）。
//   下次再夸之前，用 `recentPraiseTexts()` 取最近夸过的话，直接喂进 LLM 提示词
//   让模型避开同样的说法（2026-11-04 起文案由 LLM 生成，不再做向量相似检索）。
//
// 为什么不用现成的 qa_vec 表：那张表是答疑库条目的检索索引，语义和生命周期都不一样；
// 混在一起会让「答疑库重建索引」把夸奖记录清掉。

import { openDb } from './db.mjs';
import { tokenize } from './qa-vector.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS praise_reply (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    TEXT,
  comment_id TEXT,
  author     TEXT,
  comment_text TEXT,   -- 被夸的那条回答
  praise_text  TEXT,   -- 我们实际发出去的夸奖
  point      TEXT,     -- 抽出来的要点词（没有就空）
  vec        TEXT,     -- 稀疏向量（JSON）
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_praise_created ON praise_reply(created_at);
`;

/** 简单稀疏向量：token → 词频权重（夸奖文本短，不需要 idf 也能区分） */
function vectorize(text) {
  const tf = new Map();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + 1);
  let sum = 0;
  for (const w of tf.values()) sum += w * w;
  const norm = Math.sqrt(sum) || 1;
  const out = {};
  for (const [k, w] of tf) out[k] = Number((w / norm).toFixed(6));
  return out;
}

export function openPraiseDb(config) {
  const file = config?.paths?.praiseDbFile || config?.paths?.postDbFile;
  const db = openDb(file);
  db.exec(SCHEMA);
  return db;
}

/** 存一条夸奖记录 */
export function savePraise(db, { postId, commentId, author, commentText, praiseText, point = '' }) {
  if (!db || !praiseText) return;
  db.prepare(
    `INSERT INTO praise_reply (post_id, comment_id, author, comment_text, praise_text, point, vec, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    String(postId || ''),
    String(commentId || ''),
    String(author || ''),
    String(commentText || '').slice(0, 500),
    String(praiseText || ''),
    String(point || ''),
    JSON.stringify(vectorize(`${praiseText} ${commentText}`)),
    Date.now()
  );
}

/** 取最近 N 条夸奖文本（用于「一字不差说过的不再说」） */
export function recentPraiseTexts(db, limit = 500) {
  if (!db) return [];
  try {
    return db
      .prepare('SELECT praise_text FROM praise_reply ORDER BY id DESC LIMIT ?')
      .all(Number(limit))
      .map((r) => r.praise_text)
      .filter(Boolean);
  } catch {
    return [];
  }
}
