// 通知：「回复和@我收到的」（2026-11-04 用真实 cURL 校准）
//
//   GET /webapiv2/notification/v2/by-me?type=7
//   referer: https://www.taptap.cn/notifications?show_type=7&reply_type=gets
//
// ⚠️ 这个接口**要鉴权**，而 `lib/http.mjs` 的 `ttGet` 是裸 fetch（feed/评论是公开接口才没暴露）。
//    用裸 fetch 调它会返回「未认证」。所以必须走页面上下文（见 lib/taptap-api.mjs 的 notifications()）。
//
// 为什么用它：冷帖唤醒要判断「有没有人回复我 / @我」，
//   靠「评论数变了 → 去读评论 → 猜」既慢又不准（还得读评论）；
//   通知接口直接给出：谁、在哪个帖子的哪条评论下、说了什么、@没@我。

import { makeRunner } from './replier.mjs';
import { getTapApi } from './taptap-api.mjs';

/**
 * 把一条通知解析成好用的结构
 * @param {object} item 通知原始项
 * @returns {{id:string, action:string, senderId:string, senderName:string,
 *            title:string, content:string, momentId:string, commentId:string,
 *            quoted:string, time:number}}
 */
export function parseNotification(item = {}) {
  const d = item.data || {};
  const ext = item.extend?.contents || {};
  // uri 形如 https://www.taptap.cn/moment/866300950728409356#comment-id=404364961
  const uri = String(d.uri || '');
  const mMoment = uri.match(/\/moment\/(\d+)/);
  const mComment = uri.match(/comment-id=(\d+)/);
  const sender = item.sender?.user || {};
  return {
    id: String(item.id || ''),
    action: String(item.action || ''), // comment / at / …
    senderId: String(sender.id || ''),
    senderName: String(sender.name || sender.nickname || ''),
    title: String(d.title || ''),
    content: String(d.content || ''),
    momentId: mMoment ? mMoment[1] : '',
    commentId: mComment ? mComment[1] : '',
    quoted: String(ext.content || ''), // 被回复的那条（我们的评论原文）
    time: Number(item.created_time || 0),
  };
}

/**
 * 拉「回复和@我收到的」通知
 * @param {object} o { config, type=7, log }
 * @returns {Promise<Array<{...}>>} 解析后的通知列表（失败返回空数组）
 */
export async function listNotifications({ config = {}, type = 7, log = () => {} } = {}) {
  try {
    const runner = makeRunner({
      opencliMain: config.reply?.opencliMain,
      session: config.reply?.session,
    });
    if (!runner.available) return [];
    const api = getTapApi({ runner, log });
    if (!api.ensureOrigin().ok) return [];
    const res = await api.notifications({ type });
    if (!res.ok) {
      log(`  [通知] 拉取失败（${res.error || res.status}）`);
      return [];
    }
    return (res.list || []).map(parseNotification).filter((n) => n.momentId || n.content);
  } catch (e) {
    log(`  [通知] 异常：${e.message}`);
    return [];
  }
}

/**
 * 我们在论坛上可能用到的称呼（运行时算，不写进配置 —— 真实昵称不能进仓库）
 *
 * 来源：① 自己发过的帖子的作者名（state.posts 里就有，是运行时数据）
 *      ② config.summon.aliases（大肥鱼 等马甲）
 *      ③ 签名「版主助手-小鲸鱼」
 */
export function ourNames(state = {}, config = {}) {
  const out = new Set();
  for (const p of Object.values(state?.posts || {})) {
    const aid = String(p?.author_id || '');
    if (aid && String(config.myUserId || '') === aid && p?.author) out.add(String(p.author));
  }
  for (const a of config?.summon?.aliases || []) if (a) out.add(String(a));
  const sig = String(config?.reply?.signature || '');
  if (sig) {
    const inner = sig.replace(/[「」\[\]]/g, '').trim();
    if (inner) out.add(inner);
  }
  return [...out].filter(Boolean);
}

/** 这条通知是不是「@我」或「回我」（点赞不算 —— 没人需要回一个赞） */
export function isAboutMe(note, config = {}) {
  const names = config.ourNames && config.ourNames.length ? config.ourNames : ourNames(config.state || {}, config);
  const title = String(note.title || '');
  // 点赞/收藏/关注 → 不用回，排除掉
  if (/赞|收藏|关注|粉丝/.test(title)) return false;
  const text = `${note.content || ''} ${title}`;
  // ① 标题就写着「回复了你的评论」「@了你」
  if (/回复了你的|回复了你|@了你|提及了你/.test(title)) return true;
  // ② 内容里 @ 了我们的昵称/马甲/签名
  for (const n of names) {
    if (!n) continue;
    if (text.includes(`@${n}`) || text.includes(`＠${n}`)) return true;
  }
  // ③ 被回复的那条是我们的评论（extend 里带我们的签名）
  if (note.quoted && /版主助手-小鲸鱼/.test(note.quoted)) return true;
  return false;
}
