// 游戏评价（TapTap「游戏评价 / review」）相关端点的**纯函数层**
//
// 2026-11-13 大哥提供两条真实 cURL（评价列表 / 评价回复），我逐条实测校准了参数与返回结构。
// 这里的常量与函数都写成纯的，方便单测、不联网。
//
// ── ① 列表（读）—— **公开接口，不带 Cookie 也能读** ───────────────────────
//   GET /webapiv2/review/v2/list-by-app
//       ?app_id=54031&limit=10&label=&mapping=&source_type=&sort=new
//       &stage_type=&test_plan_id=&X-UA=…
//   → 200 {success:true, data:{list:[…], total, prev_page, next_page, has_collapsed_list}}
//     list[i] = {type, identification, menu, moment}
//     moment.review = {id, score, played_spent, contents:{text,raw_text},
//                      review_comments:[…], stage, stage_label, source, total_played_spent}
//
// ── ② 回复（写）─────────────────────────────────────────────────────────
//   POST /webapiv2/review-comment/v1/create   multipart/form-data
//       review_id = 51123606
//       contents  = <纯文本>
//     头：x-xsrf-token（页面上下文自动带 HttpOnly Cookie）
//   ⚠️ **contents 是纯文本**，跟论坛回复那套富文本 JSON（[{type:'paragraph',…}]）**不一样**。
//      实测落库形态 = {text, raw_text}，没有表情节点。
//      验证方式：大哥手动发过一条，读回 by-review 能看到（id 36692150，作者 63****64）。
//
// ── ③ 读某条评价的全量回复（读，**校验落库用**）─────────────────────────
//   GET /webapiv2/review-comment/v1/by-review?review_id=&limit=&from=&order=
//   → ⚠️ `order` **必填**，取值 asc|desc（oneof 校验，不过就 400）
//   → ⚠️ `limit` **上限 10**（15 / 20 都会 400：failed on the 'max' tag）
//   → 200 {data:{list:[…], total, show_all, prev_page, next_page}}
//     list[i] = {id, contents:{text,raw_text}, ups, downs, created_time,
//                 is_official, collapsed, author:{id,name,…}, …}
//
// ⚠️ **列表里的 review_comments 只是预览子集**（实测：列表只给 1 条官方回复，
//    by-review 给 2 条）→ 校验「回复有没有落库」必须走 by-review，不能信列表里的。

import { stripEmojiMarks } from './text.mjs';
import { clampReply } from './limits.mjs';

export const REVIEW_LIST_PATH = '/webapiv2/review/v2/list-by-app';
export const REVIEW_DETAIL_PATH = '/webapiv2/review/v2/detail';
export const REVIEW_COMMENTS_PATH = '/webapiv2/review-comment/v1/by-review';
export const REVIEW_REPLY_PATH = '/webapiv2/review-comment/v1/create';

/** by-review 的 limit 上限（实测 15 / 20 → 400 'max' tag，10 合法） */
export const REVIEW_LIMIT_MAX = 10;

/** by-review 的 order 合法值（实测 oneof 校验） */
export const REVIEW_ORDERS = ['asc', 'desc'];

/**
 * 列表接口的参数（默认按发布时间倒序拿最新的）
 *
 * ⚠️ 分页参数是 **`from`**（偏移量），不是 `page`/`offset`（2026-11-23 实测）：
 *    · `from=0/10/20` → 每次拿到**不同的** 10 条（真翻页）
 *    · `page` / `offset` / `page_num` / `next_page` / `pn` → 全部**无效**，都返回第一页
 *    基线响应的 `next_page` 里写的就是 `…&from=10&…`，可直接印证。
 *
 * @param {object} o
 * @param {number|string} o.appId
 * @param {number} [o.limit]  默认 10（上限 10）
 * @param {string} [o.sort]   默认 new
 * @param {number} [o.from]   偏移量（0 = 最新）
 */
export function normalizeListParams({
  appId,
  limit = 10,
  sort = 'new',
  from = 0,
  label = '',
  mapping = '',
  sourceType = '',
  stageType = '',
  testPlanId = '',
} = {}) {
  const n = Number(limit);
  return {
    app_id: String(appId ?? ''),
    limit: Math.max(1, Math.min(REVIEW_LIMIT_MAX, Number.isFinite(n) ? n : 10)),
    from: Math.max(0, Number(from) || 0),
    label: String(label ?? ''),
    mapping: String(mapping ?? ''),
    source_type: String(sourceType ?? ''),
    sort: String(sort ?? 'new'),
    stage_type: String(stageType ?? ''),
    test_plan_id: String(testPlanId ?? ''),
  };
}

/**
 * by-review 的参数
 *
 * ⚠️ order 必填（asc/desc）；limit 上限 10。
 * @param {object} o
 * @param {number|string} o.reviewId
 */
export function normalizeCommentsParams({ reviewId, limit = 10, from = 0, order = 'desc' } = {}) {
  const n = Number(limit);
  const o = String(order ?? '').toLowerCase();
  return {
    review_id: String(reviewId ?? ''),
    limit: Math.max(1, Math.min(REVIEW_LIMIT_MAX, Number.isFinite(n) ? n : 10)),
    from: Math.max(0, Number(from) || 0),
    order: REVIEW_ORDERS.includes(o) ? o : 'desc',
  };
}

/** 一条评价回复的正文（纯文本；容错：contents 可能是对象也可能是字符串） */
export function reviewCommentText(c) {
  const raw = c?.contents;
  if (typeof raw === 'string') return raw;
  return String(raw?.text ?? raw?.raw_text ?? '');
}

/**
 * 清洗评价正文里的 HTML 残留
 *
 * 实测（2026-11-23）：部分评价的 `raw_text` 带 `<br />` 等标签，
 * 直接拿去判定/显示会出现「我的账号充值了1000余元&lt;br /&gt;当时…」这种脏文本。
 * 只在**真的含标签/实体**时才处理，避免动到正常文本。
 */
export function cleanReviewText(s) {
  let t = String(s ?? '');
  if (!/[<&]/.test(t)) return t;
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, '');
  t = t
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
  return t.replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * 把列表/详情里的一个 item 摊平成统一结构
 *
 * ⚠️ `review/v2/detail` 返回的 `data.review` 是**空壳**（对象但字段全 undefined），
 *    真正的 review 在 `data.moment.review` —— 两个位置都认一下。
 *
 * @returns {object|null}
 */
export function normalizeReview(item) {
  const moment = item?.moment || item || {};
  const rv = moment.review || item?.review || null;
  if (!rv || rv.id === undefined || rv.id === null) return null;
  const author = moment.author?.user || {};
  const id = String(rv.id);
  return {
    reviewId: id,
    score: rv.score ?? null,
    playedSpent: rv.played_spent ?? null,
    totalPlayedSpent: rv.total_played_spent ?? null,
    text: cleanReviewText(rv.contents?.text ?? rv.contents?.raw_text ?? ''),
    stage: rv.stage ?? null,
    stageLabel: rv.stage_label ?? '',
    source: rv.source ?? null,
    authorId: String(author.id ?? ''),
    authorName: String(author.name ?? ''),
    publishTime: Number(moment.publish_time ?? moment.created_time ?? 0),
    createdTime: Number(moment.created_time ?? 0),
    momentId: String(moment.id_str ?? ''),
    url: `https://www.taptap.cn/review/${id}`,
    // ⚠️ 列表里这只是**预览子集**，校验落库要走 by-review
    previewComments: Array.isArray(rv.review_comments) ? rv.review_comments : [],
  };
}

/**
 * 评价回复的正文载荷（**纯文本**）
 *
 * · 表情标记必须剥掉 —— 评价接口只吃纯文本，表情节点没验证过，宁可不发
 * · 签名由上层 clampReply 统一加（这里不重复加）
 *
 * ⚠️ `keepNewlines`（2026-11-23 新增）：
 *    默认仍是「压成单行」（历史行为，跟论坛楼中楼一致）。
 *    但**分步骤的自查指引类文案必须保留换行** —— 压成一行玩家根本没法照着做
 *    （大哥 2026-11-23 的「账号丢失」回复就是 1/2/3 分条结构）。
 *    评价接口的 contents 只是纯文本，没要求单行（论坛那个「必须单行」是楼中楼的限制）。
 */
export function buildReviewContents(text, { keepNewlines = false } = {}) {
  const s = stripEmojiMarks(String(text ?? ''));
  if (keepNewlines) {
    return s
      .split(/\r?\n/)
      .map((x) => x.trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n') // 最多留一个空行，避免大片留白
      .trim();
  }
  const s2 = s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(' ');
  return s2;
}

/** 从评价链接里取 reviewId（/review/51123606） */
export function reviewIdFromUrl(url) {
  const m = String(url || '').match(/\/review\/(\d+)/);
  return m ? m[1] : '';
}

/**
 * 在回复列表里找「我们发的那条」（按纯文本包含匹配）
 *
 * @param {Array} list  by-review 的 data.list
 * @param {string} text  我们发出去的正文
 * @param {number} [probe] 取前几个字符做特征串（避免长文全量比对）
 */
export function pickReviewComment(list, text, probe = 12) {
  const needle = String(text || '').replace(/\s+/g, '').slice(0, probe);
  if (!needle) return { found: false };
  for (const c of Array.isArray(list) ? list : []) {
    const body = reviewCommentText(c).replace(/\s+/g, '');
    if (body && body.includes(needle)) {
      return { found: true, id: c?.id ?? c?.id_str, comment: c };
    }
  }
  return { found: false };
}

/**
 * 四个评价动作包成一层
 *
 * 为什么要注入 get/post：
 *   这四个函数要发网络请求，但**不该**在单测里真发。
 *   把 get/post 注入进来 → 单测用假实现就能覆盖参数拼装、返回解析、校验逻辑。
 *
 * @param {object} deps
 * @param {Function} deps.get   (path, params) => {ok, json, status}
 * @param {Function} deps.post  (path, form, opt) => {ok, status, json, body, ...}
 */
export function makeReviewApi({ get, post } = {}) {
  /**
   * 拉游戏评价列表
   *
   * ⚠️ 这个接口**是公开的**（实测：不带 Cookie 直接打也返回 200）。
   *    这里仍走页面上下文 —— 统一一条通道，行为一致、不用维护两套取数逻辑。
   */
  async function reviewList({ appId, limit = 10, sort = 'new', from = 0 } = {}) {
    const params = normalizeListParams({ appId, limit, sort, from });
    if (!params.app_id) return { ok: false, list: [], error: '缺少 appId' };
    const r = await get(REVIEW_LIST_PATH, params);
    if (!r.ok) return { ok: false, list: [], error: r.status, json: r.json };
    const d = r.json?.data || {};
    const list = (Array.isArray(d.list) ? d.list : []).map(normalizeReview).filter(Boolean);
    // next_page 为空/缺省 = 已经翻到底（评价流到底了）
    return { ok: true, list, total: d.total, nextPage: d.next_page || '', raw: d };
  }

  /**
   * 回一条评价
   *
   * ⚠️ **contents 是纯文本** —— 跟论坛回复那套富文本 JSON（[{type:'paragraph',…}]）不一样。
   *    实测落库形态是 {text, raw_text}，没有表情节点。
   *    表情标记先剥掉（表情节点在评价接口没验证过，宁可不发）。
   *
   * @param {object} o
   * @param {number|string} o.reviewId
   * @param {string} o.text           正文
   * @param {string} [o.signature]     签名（没带就补；带了不重复加）
   * @param {string} [o.contents]      直接指定载荷（一般不用）
   */
  async function reviewReply({ reviewId, text, signature = '', contents, keepNewlines = false } = {}) {
    const rid = String(reviewId ?? '').trim();
    if (!rid) return { ok: false, stage: 'no_review_id' };
    let payload = contents;
    if (payload === undefined || payload === null) {
      // 签名统一由脚本加一次（clampReply 幂等：已经带了就不重复加）
      const capped = signature ? clampReply(text, { signature }) : String(text ?? '');
      payload = buildReviewContents(capped, { keepNewlines });
    }
    const res = await post(
      REVIEW_REPLY_PATH,
      { review_id: rid, contents: payload },
      { runtimeEnv: 'release' } // 与大哥给的真实 cURL 完全一致
    );
    return { ...res, contents: payload };
  }

  /**
   * 读某条评价的**全量**回复（校验落库用）
   *
   * ⚠️ `order` 必填（asc|desc），`limit` 上限 10 —— 传错就是 400（实测踩过）。
   * ⚠️ 列表接口里那份 review_comments 只是**预览子集**，校验必须走这里。
   */
  async function reviewComments({ reviewId, limit = 10, from = 0, order = 'desc' } = {}) {
    const params = normalizeCommentsParams({ reviewId, limit, from, order });
    if (!params.review_id) return { ok: false, list: [], error: '缺少 review_id' };
    const r = await get(REVIEW_COMMENTS_PATH, params);
    if (!r.ok) return { ok: false, list: [], error: r.status, json: r.json };
    const d = r.json?.data || {};
    const list = Array.isArray(d.list) ? d.list : [];
    return { ok: true, list, total: d.total, raw: d };
  }

  /**
   * 校验「我们发的那条评价回复」是否已落库
   *
   * 默认 order='desc'（新→旧）：我们刚发的那条一定排在最前面，翻页概率最低。
   */
  async function hasReviewReplyText({ reviewId, text, probe = 12, order = 'desc' } = {}) {
    const r = await reviewComments({ reviewId, order });
    const hit = pickReviewComment(r.list, text, probe);
    return { found: hit.found, id: hit.id, total: r.total, list: r.list };
  }

  return { reviewList, reviewReply, reviewComments, hasReviewReplyText };
}
