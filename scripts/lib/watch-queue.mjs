// 守护队列：**通知驱动的入队**（用户 2026-11-06）
//
// 原话：
//   「将通知列表，回复、与@、呼唤你，也要添加到队列（重排队列，不移除回复帖子的队列只重排，
//     注最新10条+回复，可以超过10条队列）。」
//
// 为什么单独一个模块：
//   watch.mjs 是个常驻主循环（顶层 for(;;)），没法被 import 做测试。
//   把「队列该收哪些帖子」这段纯逻辑抽出来，就能单测，也让 watch.mjs 只管调度。
//
// 两个来源：
//   ① feed 最新 N 条（新帖 / 待回复 / 评论数变了）—— 在 watch.mjs 里做
//   ② **通知**（回复我 / @我 / 呼唤我）—— 在这里做，且**不看是否在最新 N 条里**
//      「只重排、不删」：入队后按发布时间新→旧排，队列超过 10 条是正常的。

/**
 * 从 state 里收集「被通知触发」的帖子 id
 *
 * 两个地方都看（collect.mjs 会同时写）：
 *   · `state.interactPending[id]`   —— 全局表，带原因/发信人
 *   · `state.posts[id].interactPending === true` —— 帖子级标记
 *
 * @param {object} state
 * @returns {Array<{id:string, reason:string}>} 去重后的列表
 */
export function collectNotifyIds(state = {}) {
  const out = new Map();
  for (const [mid, info] of Object.entries(state?.interactPending || {})) {
    const id = String(mid || '').trim();
    if (!id) continue;
    out.set(id, String(info?.reason || '回复/@我'));
  }
  for (const [mid, p] of Object.entries(state?.posts || {})) {
    if (!p?.interactPending) continue;
    const id = String(mid || '').trim();
    if (!id) continue;
    if (!out.has(id)) out.set(id, '回复/@我');
  }
  return [...out.entries()].map(([id, reason]) => ({ id, reason }));
}

/**
 * 把通知里的帖子并入队列（**已在队列里的不重复加**）
 *
 * @param {Array}  queue       现有队列（会被 push）
 * @param {object} state
 * @param {Set}    queuedIds   现有队列的 id 集合（会被更新）
 * @returns {{added:number, ids:string[]}}
 */
export function enqueueNotifyIds(queue, state, queuedIds = new Set()) {
  const ids = [];
  for (const { id, reason } of collectNotifyIds(state)) {
    if (queuedIds.has(id)) continue;
    queue.push({
      id,
      // 通知帖常常不在 state.posts 里（滑出窗口/被搬库）→ publishTime 可能是 0，
      // 排序时自然落到后面；但队列会一直处理到空，所以不会被饿死。
      publishTime: Number(state?.posts?.[id]?.publishTime || 0),
      enqueuedAt: Date.now(),
      why: `通知：${reason}`,
    });
    queuedIds.add(id);
    ids.push(id);
  }
  return { added: ids.length, ids };
}

/**
 * 该不该现在去拉某个源（每源独立节流）
 *
 * 为什么需要：三个源每轮都拉 = 120s 内打 2 个匿名接口 + 1 个通知，
 * 实测会直接触发 TapTap 的阿里云 WAF（连 sort=created 都被拦）→ 整条链路停摆。
 * 所以让每个源有自己的节奏：
 *   · notify 走**页面上下文**（带登录 Cookie），不占匿名 IP 配额 → 可以最勤（跟队列重排同频）
 *   · created 是主链路 → 中等
 *   · commented 只是「补充捞老帖」→ 最慢
 *
 * @param {object} o
 * @param {number} o.lastAt    上次拉取时间戳（ms）
 * @param {number} o.everyMs   该源的间隔
 * @param {number} o.nowMs
 * @param {number} [o.wafUntil] 熔断截止时间戳（ms），未到期则一律不拉
 * @returns {boolean}
 */
export function shouldPullSource({ lastAt = 0, everyMs = 120000, nowMs = Date.now(), wafUntil = 0 } = {}) {
  if (nowMs < Number(wafUntil || 0)) return false; // 熔断中
  return nowMs - Number(lastAt || 0) >= Number(everyMs || 0);
}

/**
 * WAF 熔断状态推进
 *
 * @param {object} s  { strikes, until }
 * @param {boolean} blocked 这次是否被 WAF 拦了
 * @param {number} nowMs
 * @param {object} [o] { threshold=2, cooldownMs=15*60*1000 }
 * @returns {{strikes:number, until:number, tripped:boolean}}
 */
export function advanceWaf(s = { strikes: 0, until: 0 }, blocked = false, nowMs = Date.now(), o = {}) {
  const threshold = Number(o.threshold ?? 2);
  const cooldownMs = Number(o.cooldownMs ?? 15 * 60 * 1000);
  if (!blocked) return { strikes: 0, until: 0, tripped: false }; // 没被拦 → 清零
  const strikes = Number(s.strikes || 0) + 1;
  if (strikes >= threshold) {
    return { strikes, until: nowMs + cooldownMs, tripped: true };
  }
  return { strikes, until: Number(s.until || 0), tripped: false };
}

/** 队列重排：按发布时间新→旧（id 兜底），并截到上限 */
export function sortAndCap(queue, cap = 200) {
  queue.sort(
    (a, b) =>
      (Number(b.publishTime) || 0) - (Number(a.publishTime) || 0) ||
      String(b.id).localeCompare(String(a.id))
  );
  return queue.length > cap ? queue.slice(0, cap) : queue;
}

/**
 * 通知指纹：同一帖 + 同一条回复 = 同一个指纹
 *
 * 用户 2026-11-06：「应避免反复入队，同一帖子因明确回复内容按照内容含义去重，
 *                   入队1次后不再入队。」
 *
 * 所以用「帖子id : 评论id（没有就用内容前 24 字）」当指纹：
 *   · 同一条回复重复出现在通知列表里 → 指纹相同 → **只入队一次**
 *   · 同一个帖子又来了**新回复**（新 commentId / 内容变了）→ 指纹不同 → 可以再入队
 */
export function notifyFingerprint(note) {
  const mid = String(note?.momentId || '').trim();
  const cid = String(note?.commentId || '').trim();
  const body = String(note?.content || '')
    .replace(/\s+/g, '')
    .slice(0, 24);
  return `${mid}:${cid || body || 'na'}`;
}

/**
 * 把**通知接口**返回的原始列表并入队列（用户 2026-11-06）
 *
 * 通知 = `GET /webapiv2/notification/v2/by-me?type=7`（回复和@我收到的），
 * 每条已经带 `momentId` —— 所以**不需要**先写 state，也不用管它在不在最新 10 条里。
 *
 * ⚠️ 两道去重（缺一不可）：
 *   ① **seen 指纹**：这条通知（帖子+回复）入过队就再也不入 —— 这是硬约束，防死循环
 *   ② `shouldSkip`：已经判定完的帖（replied/no_need 且无待互动）跳过
 *
 * @param {Array}  queue      队列（会被 push）
 * @param {Array}  notes      `listNotifications()` 的返回值（已 parse）
 * @param {Set}    queuedIds  现有队列 id 集合（会被更新）
 * @param {Function} [isAboutMe] 过滤：只收「回复我 / @我 / 呼唤我」（点赞收藏不要）
 * @param {Function} [shouldSkip] 过滤：已经处理完的帖跳过
 * @param {object} [seen]     已入队指纹表（**会被就地更新**；持久化由调用方负责）
 * @returns {{added:number, ids:string[], skipped:number, dup:number}}
 */
export function enqueueNotifyFromNotes(
  queue,
  notes,
  queuedIds = new Set(),
  isAboutMe = () => true,
  shouldSkip = () => false,
  seen = null
) {
  const ids = [];
  let skipped = 0;
  let dup = 0;
  for (const n of notes || []) {
    const id = String(n?.momentId || '').trim();
    if (!id) continue;
    if (queuedIds.has(id)) continue;
    if (!isAboutMe(n)) continue; // 点赞/收藏/关注 → 不是「要我回话」

    const fp = notifyFingerprint(n);
    if (seen && seen[fp]) {
      dup++; // 这条通知已经入过队 → 永不再入
      continue;
    }
    if (shouldSkip(id)) {
      skipped++; // 已处理完（或不在本轮范围）→ 别再入队
      continue;
    }
    queue.push({
      id,
      fingerprint: fp,
      publishTime: Number(n?.time || 0), // 通知时间，排序兜底用
      enqueuedAt: Date.now(),
      why: `通知：${n?.title || n?.action || '回复/@我'}`,
      needsComments: true, // 通知驱动的帖**必须重新读评论**（楼中楼回复不一定改顶层评论数）
    });
    queuedIds.add(id);
    if (seen) seen[fp] = Date.now(); // 入队即记账：这条以后不再入
    ids.push(id);
  }
  return { added: ids.length, ids, skipped, dup };
}

/** 清理过旧的指纹（只留最近 limit 条，按时间倒序） */
export function pruneSeen(seen, limit = 800) {
  const entries = Object.entries(seen || {});
  if (entries.length <= limit) return seen || {};
  entries.sort((a, b) => Number(b[1]) - Number(a[1]));
  return Object.fromEntries(entries.slice(0, limit));
}

/**
 * 把 feed 里的一条 item 并入队列（新帖 / 按回复时间拉的帖都走这里）
 *
 * @returns {boolean} 是否真的入队
 */
export function enqueueFeedItem(queue, queuedIds, {
  id,
  publishTime = 0,
  why = '新帖',
  needsComments = false,
} = {}) {
  const key = String(id || '').trim();
  if (!key || queuedIds.has(key)) return false;
  queue.push({ id: key, publishTime: Number(publishTime) || 0, enqueuedAt: Date.now(), why, needsComments });
  queuedIds.add(key);
  return true;
}