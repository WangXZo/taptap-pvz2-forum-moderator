// TapTap 社区只读接口封装（匿名可读，已实测）
// 写操作不在这里 —— 官方没有写接口，见 lib/replier.mjs（opencli 驱动真实浏览器）

import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const X_UA =
  'V=1&PN=WebApp&LANG=zh_CN&VN_CODE=102&VN=3.62.0&LOC=CN&PLT=PC&DS=Android&OS=Windows&OSV=10&DT=PC&CH=chrome';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const BASE = 'https://www.taptap.cn/webapiv2';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export class WafBlocked extends Error {}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// 操作最短间隔（用户 2026-11-06：「设置操作最短间隔（0.3s）」）
//
// 所有**匿名接口**请求（feed / 评论）统一在这里排队间隔，
// 比在各调用点手写 sleep 更可靠 —— 不会漏，也不会因为新增脚本而失控。
// 注意：已登录接口（taptap-api.mjs）自己另有 1s 节流，不走这里。
// ------------------------------------------------------------
const MIN_OP_GAP_MS = 300;
let lastReqAt = 0;

async function throttle(fnName = '') {
  const wait = MIN_OP_GAP_MS - (Date.now() - lastReqAt);
  if (wait > 0) await sleep(wait);
  lastReqAt = Date.now();
  void fnName;
}

// ------------------------------------------------------------
// 页面上下文兜底（用户 2026-11-06：WAF 需人工验证，匿名通道随时可能被拦）
//
// 匿名 fetch（本文件的 ttGet）用的是固定 UA、**不带 Cookie** —— 一旦 IP 被 WAF 策略标记，
// 即使人在浏览器里验证过了，匿名请求仍可能继续被拦。
// 而「页面内 fetch」带登录 Cookie + 浏览器指纹，走的是另一条通道。
//
// 所以：由守护进程/采集器在启动时注入一个 pageFetcher，
//      下面的 listFeed / listComments **优先走页面**，失败再退回匿名。
// 这样不用把 opencli 依赖硬塞进 http.mjs。
// ------------------------------------------------------------
let pageFetcher = null;

/** 注入页面上下文 fetcher：(path, params) => Promise<data|null> */
export function setPageFetcher(fn) {
  pageFetcher = typeof fn === 'function' ? fn : null;
}

/** 有页面通道就先用它 */
async function tryPage(path, params) {
  if (!pageFetcher) return null;
  try {
    return await pageFetcher(path, params);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// WAF 熔断标记（用户 2026-11-06 明确）：
//   「WAF 拦截，无时间限制，需要人工验证解除」
//
// 所以这里**不做自动解封**，也**不重试**（重试只会继续撞、可能加重封禁）：
//   一旦被拦 → 立刻落下 data/waf-blocked.json → 守护进程整体熔断（只留通知源）
//   → 人工到浏览器完成人机验证 → `node scripts/waf.mjs clear` 解除
// ------------------------------------------------------------

export function wafFlagPath() {
  return resolve(SKILL_ROOT, 'data/waf-blocked.json');
}

/** WAF 拦截时落标记（幂等：已经有就不覆盖首次时间） */
export function markWafBlocked(path = '') {
  try {
    const p = wafFlagPath();
    mkdirSync(dirname(p), { recursive: true });
    const old = readWafFlag();
    const body = {
      at: old?.at || new Date().toISOString(),
      lastAt: new Date().toISOString(),
      path: path || old?.path || '',
      hint:
        '到浏览器打开 https://www.taptap.cn 完成人机验证（可能需要滑动/点击），' +
        '验证通过后运行：node scripts/waf.mjs clear',
    };
    writeFileSync(p, JSON.stringify(body, null, 2), 'utf8');
  } catch {
    /* 落标记失败不影响主流程 */
  }
}

/** 读熔断标记（没有返回 null） */
export function readWafFlag() {
  try {
    return JSON.parse(readFileSync(wafFlagPath(), 'utf8'));
  } catch {
    return null;
  }
}

/** 人工确认已解除后清标记 */
export function clearWafFlag() {
  try {
    unlinkSync(wafFlagPath());
    return true;
  } catch {
    return false;
  }
}

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
      await throttle(path); // 每次出站请求前先满足 0.3s 最短间隔
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
        // ⚠️ 不重试：WAF 无自动解封时间，必须人工验证（见本文件顶部说明）
        markWafBlocked(path);
        throw new WafBlocked(`${path} 被 WAF 拦截（HTTP ${res.status}）—— 需人工验证`);
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
      if (e instanceof WafBlocked) throw e; // WAF → 直接抛，绝不重试
      if (i < retries) {
        const wait = backoff * (i + 1) * 0.4;
        console.warn(`  [退避] ${Math.round(wait / 1000)}s 后重试：${e.message}`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

/**
 * 论坛帖子流。
 * 实测约束：limit 最大 10；sort = created（发布时间降序）/ commented（回复时间）/ default（推荐）。
 *
 * **优先走页面上下文**（带登录 Cookie，不受匿名 WAF 影响），拿不到再退回匿名 ttGet。
 */
export async function listFeed({ groupId, from = 0, limit = 10, sort = 'default', type = 'feed' }) {
  const params = {
    group_id: groupId,
    from,
    limit,
    sort,
    status: 0,
    type,
    with_hot_comment: 'true',
  };
  const viaPage = await tryPage('/webapiv2/feed/v7/by-group', params);
  if (viaPage && Array.isArray(viaPage.list)) return viaPage;
  return ttGet('/feed/v7/by-group', params);
}

/**
 * 某帖的一级回复列表（含楼中楼 child_posts）
 * limit 上限：实测 30 可用；50 会报 `ByMomentRequest.limit failed on the 'max' tag`
 *
 * 同样**优先页面上下文**，拿不到再退回匿名。
 */
export async function listComments({ momentId, from = 0, limit = 30 }) {
  const params = { moment_id: momentId, from, limit };
  const viaPage = await tryPage('/webapiv2/moment-comment/v1/by-moment', params);
  if (viaPage && Array.isArray(viaPage.list)) return viaPage;
  return ttGet('/moment-comment/v1/by-moment', params);
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
