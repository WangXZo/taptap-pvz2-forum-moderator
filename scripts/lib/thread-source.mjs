// 线程数据源（2026-11-20）：官方 CLI 优先，旧接口降级
//
// 为什么需要这层：
//   旧接口（`/webapiv2/moment-comment/v1/by-moment`）有两个硬伤：
//     ① `child_posts` 只返前 2 条 —— 我们自己发出去的子回复读不到 → 幂等门盲判
//     ② 我们曾因此**漏读关键答案**（帖 872475707622556454 的第 3 条子回复才是正解）
//   官方 CLI 的 `list-community-moment-child-replies` 给全量（实测 total=5 / 7）。
//
// 但 CLI 依赖版主权限与本地安装，所以**必须可降级**：CLI 失败一律回退旧接口，
// 绝不因为 CLI 挂了就不回复玩家（大哥要求保留 opencli 作过渡）。

import { listComments } from './http.mjs';
import { begin, phaseTrace } from './perf.mjs';

/**
 * 官方回复 → 内部评论结构
 *
 * 内部结构（历史约定，勿改）：
 *   { id_str, contents:{json:Array}, author:{name,id}, created_time, child_posts:[] }
 * 官方结构：
 *   { comment_id, content, contents_json, author:{name,user_id}, created_time, child_replies }
 */
export function adaptCliReply(r, { parentId = null } = {}) {
  let json = [];
  try {
    const parsed = JSON.parse(String(r?.contents_json || '[]'));
    if (Array.isArray(parsed)) json = parsed;
  } catch {
    json = [];
  }
  // contents_json 解析失败时，退化成「一段纯文本」，保证 commentText 仍能拿到字
  if (!json.length && r?.content) json = [{ type: 'paragraph', children: [{ text: String(r.content) }] }];
  return {
    id_str: String(r?.comment_id || ''),
    contents: { json },
    /** 官方给的 BBCode 投影（`[tapemoji=75][/tapemoji]`），做兜底与排查用 */
    content_raw: String(r?.content || ''),
    author: {
      name: r?.author?.name || '',
      id: String(r?.author?.user_id || ''),
      avatar: r?.author?.avatar || '',
      url: r?.author?.url || '',
    },
    created_time: Number(r?.created_time || 0),
    ups: Number(r?.ups || 0),
    pinned: Boolean(r?.pinned),
    reply_to: r?.reply_to
      ? { name: r.reply_to.name || '', id: String(r.reply_to.user_id || '') }
      : null,
    child_posts: [],
    __parentId: parentId,
    __source: 'cli',
  };
}

/** 把 CLI 的 listThread 结果转成内部 comments 结构 */
export function adaptCliThread(replies = []) {
  return (replies || []).map((r) => {
    const head = adaptCliReply(r);
    head.child_posts = (r.child_replies || [])
      .map((k) => adaptCliReply(k, { parentId: head.id_str }))
      .filter((k) => k.id_str);
    return head;
  });
}

/**
 * @param {object} o
 * @param {object} o.cli        createTapCli() 实例（可为 null）
 * @param {object} o.config
 * @param {Function} [o.log]
 * @param {Function} [o.legacyList] 注入旧接口（测试）
 */
export function createThreadSource({ cli = null, config = {}, log = () => {}, legacyList = listComments } = {}) {
  const cfg = config.taptapCli || {};
  const enabled = cfg.enabled !== false && Boolean(cli);
  const appId = String(config.appId || '');

  /**
   * 拉一帖的全部讨论（一级 + 子回复）
   * @returns {{ok:boolean, comments:Array, source:'cli'|'legacy', total?:number, childTotal?:number, fallback?:string}}
   */
  async function load({ momentId, limit = 30 }) {
    const __t0 = begin();
    try {
      if (enabled) {
        const r = await cli.listThread({ appId, momentId });
        if (r.ok) {
          const comments = adaptCliThread(r.replies);
          return {
            ok: true,
            comments,
            source: 'cli',
            total: r.total,
            childTotal: r.childTotal,
          };
        }
        // 降级：绝不因此不干活
        log(`    [CLI] 拉讨论失败（${r.error || 'unknown'}）→ 回退旧接口`);
        if (cfg.fallbackToOpencli === false) {
          return { ok: false, comments: [], source: 'cli', fallback: r.error };
        }
      }
      try {
        const c = await legacyList({ momentId, from: 0, limit });
        return { ok: true, comments: c?.list || [], source: 'legacy' };
      } catch (e) {
        log(`    [旧接口] 拉讨论失败（${e.message}）`);
        return { ok: false, comments: [], source: 'legacy', fallback: String(e?.message || e) };
      }
    } finally {
      phaseTrace(config, 'fetch_comments', __t0, { postId: momentId });
    }
  }

  return { load, enabled, appId };
}