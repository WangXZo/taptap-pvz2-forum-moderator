// 帖子维度的**冷热分离**（用户 2026-11-02）
//
// 原话：「改为每天归档，按照帖子维度，自动区分整理为冷数据（需要是向量库数据库、
//        可按照最新互动时间超时冷藏 + 按照类别分别设置）。
//        自己的帖子，如有回复（包含楼中楼），唤醒为热数据。
//        非自己的帖子，当回复我时（会@我）或呼唤你过去交互时，唤醒为热数据。」
//
// 三个概念：
//   · 热数据 = state.json 里的 posts（活跃帖）+ post_record 表（当前状态）
//   · 冷数据 = post_cold 表（**带向量**，可检索；不是死数据，是「凉但还在」）
//   · 唤醒   = 冷帖出现值得处理的动静 → 搬回热数据，重新进入正常流程
//
// 为什么冷数据要带向量：
//   冷帖不是删掉，是「凉」。以后遇到相似的问题，还能从冷库里捞出「以前有人问过/答过这个」。
//   所以冷库要能**检索**（searchCold），而不是只能按 id 翻。
//
// 为什么按类别分别设 TTL（2026-11-05 用户定的值）：
//   加好友帖 1 天就凉（天天刷屏）；提问 10 天；闲聊 15 天；
//   自己的帖 20 天；分享 30 天；官方 60 天。
//   ⚠️ 真正生效的是 config.archive.coldDays（config 优先），这里的只是兜底默认值。

import { tokenize, cosine } from './qa-vector.mjs';

const DAY = 86400000;

/** 类别定义 + 默认冷藏天数（config.archive.coldDays 可覆盖） */
export const CATEGORIES = {
  mine: { label: '我的帖', coldDays: 20, note: '自己发的；有人回（含楼中楼）就唤醒' },
  friend: { label: '加好友广告', coldDays: 1, note: '天天刷屏，最快凉' },
  official: { label: '官方/版主', coldDays: 60, note: '公告类，很少需要重看' },
  share: { label: '分享/进度', coldDays: 30, note: '攻略、晒进度，长期有价值' },
  question: { label: '提问', coldDays: 10, note: '有人回就还热着' },
  chat: { label: '闲聊/吐槽', coldDays: 15, note: '泛讨论' },
};

export const DEFAULT_COLD_DAYS = Object.fromEntries(
  Object.entries(CATEGORIES).map(([k, v]) => [k, v.coldDays])
);

/**
 * 给帖子分类
 * @param {object} post  { title, text, author, authorId, reason, status, modTask }
 * @param {object} opts  { config, myUserId }
 */
export function classifyPost(post = {}, { config = {}, myUserId = '' } = {}) {
  const me = String(myUserId || config.myUserId || '');
  const authorId = String(post.authorId || post.author_id || '');
  const title = String(post.title || '');
  const text = String(post.text || '');
  const all = `${title}\n${text}`;

  // ① 自己的帖（唤醒规则不一样：只要有人回就热）
  if (me && authorId && authorId === me) return 'mine';
  // ② 加好友广告
  if (post.friendHit || post.modTask?.detected || /加好友|互加|好友位|扩列/.test(title)) {
    return 'friend';
  }
  // ③ 官方 / 版主
  if (post.isModerator || /官方|公告|版主/.test(title)) return 'official';
  // ④ 分享 / 进度
  if (/分享|攻略|记录|进度|打卡|晒图/.test(all)) return 'share';
  // ⑤ 提问
  if (post.looksQuestion === true || /[?？]|怎么|如何|为什么|求助|请问/.test(all)) {
    return 'question';
  }
  // ⑥ 其余
  return 'chat';
}

/** 该类别冷藏多少天 */
export function coldTtlDays(category, config = {}) {
  const custom = config.archive?.coldDays || {};
  const d = Number(custom[category] ?? DEFAULT_COLD_DAYS[category] ?? 45);
  return Number.isFinite(d) && d > 0 ? d : 45;
}

/** 稀疏向量（字符 n-gram，和 qa-vector 同一套切词） */
function vectorize(text) {
  const tf = new Map();
  for (const t of tokenize(String(text || ''))) tf.set(t, (tf.get(t) || 0) + 1);
  let sum = 0;
  for (const w of tf.values()) sum += w * w;
  const norm = Math.sqrt(sum) || 1;
  const out = {};
  for (const [k, w] of tf) out[k] = Number((w / norm).toFixed(6));
  return out;
}

/**
 * 把一条帖子写进冷库
 */
export function putCold(db, post, { category, text = '', commentCount = 0, lastInteractionAt = 0, now = Date.now() } = {}) {
  if (!db || !post?.id) return false;
  db.prepare(
    `INSERT INTO post_cold
       (id, url, title, author, author_id, board, publish_time, category, qa_status, status,
        keyword, text, vec, comment_count, last_interaction_at, cold_at, woken_at, wake_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)
     ON CONFLICT(id) DO UPDATE SET
       category=excluded.category, text=excluded.text, vec=excluded.vec,
       comment_count=excluded.comment_count, last_interaction_at=excluded.last_interaction_at,
       cold_at=excluded.cold_at, woken_at=NULL, wake_reason=NULL`
  ).run(
    String(post.id),
    post.url || null,
    post.title || null,
    post.author || null,
    post.authorId || null,
    post.board || null,
    Number(post.publishTime || 0) || null,
    category,
    post.qaStatus || post.status || null,
    post.status || null,
    post.keyword || null,
    String(text).slice(0, 2000),
    JSON.stringify(vectorize(`${post.title || ''} ${text}`)),
    Number(commentCount || 0),
    Number(lastInteractionAt || 0),
    now
  );
  return true;
}

/** 冷库里有这条吗（还没被唤醒） */
export function isCold(db, id) {
  if (!db) return false;
  const r = db.prepare('SELECT id FROM post_cold WHERE id = ? AND woken_at IS NULL').get(String(id));
  return !!r;
}

/** 取冷库里的帖子（还没被唤醒的） */
export function coldRows(db, { limit = 500 } = {}) {
  if (!db) return [];
  try {
    return db
      .prepare('SELECT * FROM post_cold WHERE woken_at IS NULL ORDER BY last_interaction_at ASC LIMIT ?')
      .all(Number(limit));
  } catch {
    return [];
  }
}

/** 标记：这条冷帖被唤醒了（搬回热数据，但记录留在库里备查） */
export function markWoken(db, id, reason, now = Date.now()) {
  if (!db) return;
  db.prepare('UPDATE post_cold SET woken_at = ?, wake_reason = ? WHERE id = ?').run(now, String(reason || ''), String(id));
}

/**
 * 判断一条冷帖**该不该被唤醒**
 *
 * @param {object} o
 * @param {object} o.coldRow   冷库里的那一行（comment_count = 搬进去时的评论数）
 * @param {Array}  o.comments  现在的评论列表（含楼中楼）
 * @param {object} o.config
 * @param {string} o.myUserId
 * @param {Function} o.isSummon  呼唤判定（isSummonText）
 * @param {Function} o.isOurComment  我们自己发的？
 * @returns {{wake:boolean, reason:string, detail?:string}}
 */
export function shouldWake({
  coldRow,
  comments = [],
  config = {},
  myUserId = '',
  isSummon = () => false,
  isOurComment = () => false,
}) {
  const me = String(myUserId || config.myUserId || '');
  const authorId = String(coldRow?.author_id || '');
  const stored = Number(coldRow?.comment_count || 0);
  const now = comments.length;

  // 别人（或自己）的帖，只要**有新评论**（含楼中楼）就说明它又热了
  const newComments = now > stored;

  // ① 自己的帖：有人回（含楼中楼）→ 唤醒
  if (me && authorId === me) {
    if (newComments) {
      return { wake: true, reason: '我的帖有新回复', detail: `评论 ${stored} → ${now}` };
    }
    return { wake: false, reason: '我的帖没有新回复' };
  }

  // ② 别人的帖：只有**回复我**（@我）或**呼唤我**才唤醒
  const newOnes = comments.slice(stored); // 只看新增的那些（可能不准，但保守）
  for (const c of newOnes.length ? newOnes : comments) {
    const text = String(c?.text || '');
    if (!text) continue;
    if (isOurComment(c)) continue; // 我们自己发的，不算「回复我」
    // @我：文本里出现 @ + 我们的标识
    const atMe = /[@＠]/.test(text) && mentionsUs(text, config);
    if (atMe) return { wake: true, reason: '有人在帖子里@我', detail: text.slice(0, 40) };
    if (isSummon(text, config)) {
      return { wake: true, reason: '有人呼唤我', detail: text.slice(0, 40) };
    }
  }
  return { wake: false, reason: '没有@我也没有呼唤我' };
}

/** 文本里是否 @ 到了我们（用签名 + 别名） */
function mentionsUs(text, config = {}) {
  const t = String(text || '').toLowerCase();
  const sig = String(config?.reply?.signature || '');
  const inner = sig.replace(/[「」\[\]]/g, '');
  const aliases = [
    ...(config?.summon?.aliases || []),
    '版主助手',
    '小鲸鱼',
    inner,
    sig,
  ].filter(Boolean);
  for (const a of aliases) {
    const key = String(a).toLowerCase();
    if (!key) continue;
    if (t.includes(key)) return true;
  }
  return false;
}

/**
 * 冷库检索（向量）——「以前有人问过这个吗」
 * @returns {Array<{id,title,author,category,score,text}>}
 */
export function searchCold(db, text, { topN = 5, minScore = 0.12, category = null } = {}) {
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT id,title,author,category,text,vec FROM post_cold
         WHERE woken_at IS NULL ${category ? 'AND category = ?' : ''} LIMIT 1000`
      )
      .all(...(category ? [category] : []));
    const q = vectorize(text);
    const qm = new Map(Object.entries(q));
    const out = [];
    for (const r of rows) {
      let v;
      try {
        v = new Map(Object.entries(JSON.parse(r.vec || '{}')));
      } catch {
        continue;
      }
      const s = cosine(qm, v);
      if (s >= minScore) out.push({ ...r, score: Number(s.toFixed(3)) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, topN);
  } catch {
    return [];
  }
}

/** 冷库统计（体检/报表用） */
export function coldStats(db) {
  if (!db) return { total: 0, byCategory: {} };
  try {
    const total = db.prepare('SELECT COUNT(*) c FROM post_cold WHERE woken_at IS NULL').get()?.c ?? 0;
    const rows = db
      .prepare('SELECT category, COUNT(*) c FROM post_cold WHERE woken_at IS NULL GROUP BY category')
      .all();
    return { total, byCategory: Object.fromEntries(rows.map((r) => [r.category, r.c])) };
  } catch {
    return { total: 0, byCategory: {} };
  }
}

/**
 * 把凉掉的帖子搬进冷库（每天跑一次）
 *
 * 判定：**最新互动时间**距今 > 该类别的 TTL → 冷藏
 *   「最新互动时间」= 帖子的评论/楼中楼最后一条时间；没有就用发布时间
 *
 * ⚠️ 只搬**已经判定完**的（replied / no_need）；待回复、需人工的不搬 —— 它们还要处理。
 *
 * @param {object} state  state.json（含 posts）
 * @param {object} db     post-records.sqlite（post_cold 表在这里）
 * @param {object} o      { config, log, now }
 * @returns {{moved:number, byCategory:object, kept:number}}
 */
export function archiveToCold(state, db, { config = {}, log = () => {}, now = Date.now() } = {}) {
  const out = { moved: 0, byCategory: {}, kept: 0 };
  if (!db || !state?.posts) return out;

  const me = String(config.myUserId || '');
  const posts = Object.entries(state.posts);
  for (const [id, p] of posts) {
    // 只搬已判定完的
    const done = ['replied', 'no_need'].includes(String(p?.status || ''));
    if (!done) continue;

    const category = classifyPost(
      {
        id,
        title: p?.title,
        text: p?.text || p?.summary || '',
        author: p?.author,
        authorId: p?.author_id || p?.authorId,
        status: p?.status,
        qaStatus: p?.qa_status,
        looksQuestion: p?.looksQuestion,
      },
      { config, myUserId: me }
    );
    const ttl = coldTtlDays(category, config);
    const lastInteraction = Number(
      p?.lastInteractionAt || p?.commentedTime || p?.publishTime || p?.firstSeenTs || 0
    );
    // 没有时间锚点的不动它（避免刚进来就被搬走）
    if (!lastInteraction) continue;
    const ageDays = (now - lastInteraction) / DAY;
    if (ageDays < ttl) {
      out.kept++;
      continue;
    }

    const text = String(p?.text || p?.summary || '');
    putCold(
      db,
      {
        id,
        url: p?.url,
        title: p?.title,
        author: p?.author,
        authorId: p?.author_id || p?.authorId,
        board: p?.board,
        publishTime: p?.publishTime,
        qaStatus: p?.qa_status,
        status: p?.status,
        keyword: p?.keyword,
      },
      {
        category,
        text,
        commentCount: Number(p?.scannedComments ?? p?.commentCount ?? 0),
        lastInteractionAt: lastInteraction,
        now,
      }
    );
    delete state.posts[id];
    out.moved++;
    out.byCategory[category] = (out.byCategory[category] || 0) + 1;
    log(
      `      冷藏《${String(p?.title || id).slice(0, 18)}》[${category}] ` +
        `凉 ${Math.round(ageDays)} 天 > TTL ${ttl} 天`
    );
  }
  return out;
}

/**
 * 唤醒一批冷帖（发现值得处理的动静 → 搬回热数据）
 *
 * @param {object} db
 * @param {object} state
 * @param {Array}  candidates  [{ id, comments }] —— 由调用方（collect.mjs）提供评论
 * @returns {{woken:number, items:Array}}
 */
export function wakeUp(db, state, candidates, { config = {}, isSummon, isOurComment, now = Date.now() } = {}) {
  const items = [];
  const rows = new Map(coldRows(db).map((r) => [r.id, r]));
  for (const cand of candidates || []) {
    const row = rows.get(String(cand.id));
    if (!row) continue;
    const verdict = shouldWake({
      coldRow: row,
      comments: cand.comments || [],
      config,
      myUserId: config.myUserId || '',
      isSummon,
      isOurComment,
    });
    if (!verdict.wake) continue;
    markWoken(db, cand.id, verdict.reason, now);
    // 搬回热数据（重新进入正常流程）
    if (state?.posts) {
      state.posts[String(cand.id)] = {
        ...(state.posts[String(cand.id)] || {}),
        id: String(cand.id),
        url: cand.url || row.url,
        title: cand.title || row.title,
        author: cand.author || row.author,
        author_id: row.author_id,
        publishTime: row.publish_time,
        status: 'pending', // 重新判定
        wokenAt: new Date(now).toISOString(),
        wakeReason: verdict.reason,
        cold: false,
      };
    }
    items.push({ id: cand.id, reason: verdict.reason, detail: verdict.detail });
  }
  return { woken: items.length, items };
}

/**
 * 按**通知**唤醒冷帖（2026-11-04）
 *
 * 通知接口 `/notification/v2/by-me?type=7` 直接给出「谁、在哪个帖子的哪条评论下说了什么」，
 * 所以判断「这个冷帖有没有被顶起来」不用再去读评论猜 —— 一次请求就够。
 *
 * @param {object} db
 * @param {object} state
 * @param {Array}  notes  listNotifications() 的结果
 * @param {object} o { config, isAboutMe, now }
 * @returns {{woken:number, items:Array}}
 */
export function wakeByNotifications(db, state, notes, { config = {}, isAboutMe = () => true, now = Date.now() } = {}) {
  const items = [];
  const seen = new Set();
  for (const n of notes || []) {
    const momentId = String(n.momentId || '');
    if (!momentId || seen.has(momentId)) continue;
    if (!isCold(db, momentId)) continue; // 只处理还在冷库里的
    // 通知里带 @我 / 回我 的，才值得唤醒（用户 2026-11-02 的规则）
    if (!isAboutMe(n, config)) continue;
    seen.add(momentId);
    markWoken(db, momentId, `通知：${n.title || n.action}`, now);
    if (state?.posts) {
      state.posts[momentId] = {
        ...(state.posts[momentId] || {}),
        id: momentId,
        status: 'pending',
        wokenAt: new Date(now).toISOString(),
        wakeReason: `通知：${n.title || n.action}`,
        wakeFrom: n.senderName || '',
        cold: false,
      };
    }
    items.push({ id: momentId, reason: `通知：${n.title || n.action}`, from: n.senderName, content: n.content });
  }
  return { woken: items.length, items };
}

export { DAY };
