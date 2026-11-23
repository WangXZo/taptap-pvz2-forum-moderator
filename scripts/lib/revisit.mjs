// 回访机制（T30，2026-11-20）：**我们回过的帖**，定期复查有没有玩家的新回复
//
// 为什么需要（大哥报的「回复不及时、不回复」实例）：
//   帖 872166231715613408 —— 我们 14:19:01 回了他，他 14:19:25 回「老年人用不惯qq」，
//   之后**我们再没回过**，而 `post_event` 里这帖一条记录都没有。
//
//   根因：唤醒只靠**通知接口**（type=7）。而：
//     ① 当时的 @ 是纯文本 → **不触发对方的 @ 通知**（T29 已改成真 mention 节点，会改善）
//     ② 通知接口也可能漏（玩家回的是楼中楼、通知没归到「回复我」…）
//   于是「玩家回了我们」这件事，我们可能根本不知道。
//
// 解法：**主动回访**。不是等通知，而是定期把我们回过的帖重新读一遍评论，
//   看有没有我们没接上的新回复。collect 里的幂等门保证不会重复回。
//
// 成本控制：
//   · 只回访**最近 N 天内我们回过**的帖
//   · 每帖**最多每 M 分钟**回访一次（用 post_event 的 kind='revisit' 记时间）
//   · 每轮最多取 K 个（按我们最后回复时间倒序，优先最近的）

/** 候选帖查询：最近 N 天内我们回过、且超过 M 分钟没回访的 */
export const REVISIT_EVENT = 'revisit';

/**
 * @param {object} o
 * @param {object} o.db
 * @param {object} [o.config]
 * @param {number} [o.now]
 * @param {number} [o.limit=10]
 * @returns {{ok:boolean, ids:Array<{id, title, lastReplyAt, lastRevisitAt}>, skipped:number, reason?:string}}
 */
export function pickRevisitTargets({
  db,
  config = {},
  now = Date.now(),
  limit = 10,
} = {}) {
  const cfg = config.interact || {};
  if (cfg.revisitRepliedPosts === false) {
    return { ok: true, ids: [], skipped: 0, reason: 'disabled' };
  }
  if (!db) return { ok: false, ids: [], skipped: 0, reason: 'no_db' };

  const days = Math.max(1, Number(cfg.revisitDays ?? 3));
  const everyMin = Math.max(1, Number(cfg.revisitEveryMinutes ?? 30));
  const sinceReply = now - days * 86400000;
  const sinceRevisit = now - everyMin * 60000;

  try {
    // 我们回过的帖（qa_status='replied'）→ 按更新时间倒序取候选
    const rows = db
      .prepare(
        `SELECT p.id, p.title, p.updated_at AS lastReplyAt
           FROM post_record p
          WHERE p.qa_status = 'replied'
            AND p.updated_at > ?
          ORDER BY p.updated_at DESC
          LIMIT ?`
      )
      .all(sinceReply, Math.max(limit * 4, 40));

    const ids = [];
    let skipped = 0;
    for (const r of rows) {
      // 这个帖上次回访是什么时候？
      const last = db
        .prepare(`SELECT ts FROM post_event WHERE post_id = ? AND kind = ? ORDER BY ts DESC LIMIT 1`)
        .get(String(r.id), REVISIT_EVENT);
      const lastRevisitAt = last?.ts ? Number(last.ts) : 0;
      if (lastRevisitAt > sinceRevisit) {
        skipped++; // 最近刚回访过 → 跳过
        continue;
      }
      ids.push({
        id: String(r.id),
        title: r.title || '',
        lastReplyAt: Number(r.lastReplyAt || 0),
        lastRevisitAt,
      });
      if (ids.length >= limit) break;
    }
    return { ok: true, ids, skipped, reason: null };
  } catch (e) {
    return { ok: false, ids: [], skipped: 0, reason: String(e?.message || e) };
  }
}

/**
 * 记一次回访（时间戳存在 post_event）
 * @param {object} db
 * @param {string} postId
 * @param {object} [extra]
 * @param {number} [now] 注入时钟（测试用）
 * @returns {boolean} 是否记成功
 */
export function markRevisit(db, postId, extra = {}, now = Date.now()) {
  if (!db || !postId) return false;
  try {
    db.prepare('INSERT INTO post_event (post_id, ts, kind, detail) VALUES (?, ?, ?, ?)').run(
      String(postId),
      now,
      REVISIT_EVENT,
      JSON.stringify(extra || {})
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 把回访候选并入 watch 的队列
 *
 * ⚠️ 关键点：`needsComments=true` —— 强制重新读评论。
 *   楼中楼回复不一定改顶层评论数，不强制读就会漏掉玩家的回信
 *   （这是 notify 驱动的老逻辑，回访必须继承）。
 *
 * @returns {number} 新入队数量
 */
export function enqueueRevisitTargets(queue, queued, targets, { log = () => {} } = {}) {
  let added = 0;
  for (const t of targets || []) {
    const id = String(t.id || '');
    if (!id || queued.has(id)) continue;
    const ok = enqueueFeedItem(queue, queued, {
      id,
      publishTime: t.lastReplyAt || Date.now(),
      why: '回访复查',
      needsComments: true,
    });
    if (ok) {
      added++;
      log(`  [回访] 《${String(t.title || '').slice(0, 18)}》加入复查队列`);
    }
  }
  return added;
}

/** 与 watch 共用的入队函数（保持同一套去重/排序语义） */
function enqueueFeedItem(queue, queued, item) {
  const id = String(item.id);
  if (!id || queued.has(id)) return false;
  // 队列里已有的 → 更新 why，不重复加
  const exist = queue.find((q) => String(q.id) === id);
  if (exist) {
    exist.needsComments = exist.needsComments || item.needsComments;
    return false;
  }
  queue.push({
    id,
    publishTime: Number(item.publishTime || Date.now()),
    why: item.why || '',
    needsComments: Boolean(item.needsComments),
  });
  queued.add(id);
  return true;
}
