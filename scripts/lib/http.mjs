// TapTap 社区只读接口封装（匿名可读，已实测）
// 写操作不在这里 —— 官方没有写接口，见 lib/replier.mjs（opencli 驱动真实浏览器）

const X_UA =
  'V=1&PN=WebApp&LANG=zh_CN&VN_CODE=102&VN=3.62.0&LOC=CN&PLT=PC&DS=Android&OS=Windows&OSV=10&DT=PC&CH=chrome';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const BASE = 'https://www.taptap.cn/webapiv2';

export class WafBlocked extends Error {}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function ttGet(path, params = {}, { retries = 3, backoff = 5000 } = {}) {
  const qs = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)])
  ).toString();
  const url = `${BASE}${path}${qs ? '?' + qs : ''}`;

  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'X-UA': X_UA,
          Accept: 'application/json',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      });
      const text = await res.text();
      // 阿里云 WAF 拦截会返回 HTML（HTTP 200），不是 JSON
      if (text.trimStart().startsWith('<')) {
        throw new WafBlocked(`${path} 被 WAF 拦截（HTTP ${res.status}）`);
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`${path} 返回非 JSON：${text.slice(0, 120)}`);
      }
      if (!json.success) {
        throw new Error(`API ${path} 失败: ${json.data?.msg || json.data?.error || 'unknown'}`);
      }
      return json.data;
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        const wait = e instanceof WafBlocked ? backoff * (i + 1) * 3 : backoff * (i + 1) * 0.4;
        console.warn(`  [退避] ${Math.round(wait / 1000)}s 后重试：${e.message}`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

/**
 * 论坛帖子流。
 * 实测约束：limit 最大 10；sort 只接受 'default'（'hot'/'created_at'/'rank' 会被拒）。
 * 返回 { list, total, prev_page, next_page }
 */
export function listFeed({ groupId, from = 0, limit = 10, sort = 'default', type = 'feed' }) {
  return ttGet('/feed/v7/by-group', {
    group_id: groupId,
    from,
    limit,
    sort,
    status: 0,
    type,
    with_hot_comment: 'true',
  });
}

/**
 * 某帖的一级回复列表（含楼中楼 child_posts）
 * limit 上限：实测 30 可用；50 会报
 * `ByMomentRequest.limit failed on the 'max' tag`
 */
export function listComments({ momentId, from = 0, limit = 30 }) {
  return ttGet('/moment-comment/v1/by-moment', { moment_id: momentId, from, limit });
}

/** 摊平 TapTap 富文本 contents.json 为纯文本 */
export function flattenContents(contents) {
  const blocks = contents?.json;
  if (!Array.isArray(blocks)) return '';
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string' && node.text) out.push(node.text);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  blocks.forEach(walk);
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** 从帖子条目里取标题 + 正文 */
export function extractText(item) {
  const m = item.moment || {};
  const topic = m.topic || {};
  const title = (topic.title || '').trim();
  const summary = (topic.summary || '').trim();
  const body = title || summary ? '' : flattenContents(m.contents);
  return {
    title,
    summary,
    body,
    text: [title, summary, body].filter(Boolean).join('\n'),
  };
}

/** 取帖子的「活动时间」：优先最后回复时间，其次发布时间 */
export function activityTime(item) {
  const m = item.moment || {};
  return Number(m.commented_time || m.publish_time || m.created_time || 0);
}

export const publishTime = (item) => Number(item?.moment?.publish_time || item?.moment?.created_time || 0);

export const MOMENT_URL = (id) => `https://www.taptap.cn/moment/${id}`;
