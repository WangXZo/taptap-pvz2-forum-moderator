// 预筛：先便宜地挡掉不值得识别的图，再决定要不要花钱调 VLM。
//
// 两层（大哥 2026-11-24 选定「质量预筛 + VLM 二分类」）：
//   ① 质量预筛（免费，默认开）
//      无图 / 下载失败 / 体积过小 / 纯色图 / 本批重复 → 跳过
//   ② VLM 二分类（计费，默认开、可关）
//      问模型「这张图里有没有可用于回答的信息」
//      —— 这是**通用相关性判断**（属本 skill 职责）；
//         业务相关性（这图对某个具体回答有没有用）归下游。
//
// 原则：预筛只做「明显不值得」的淘汰，判不准时**保留**（宁可多识别，不漏信息）。

import { createHash } from 'node:crypto';
import { MIN_BYTES } from './image.mjs';
import { describeImages, resolveVision } from './vision.mjs';

/** 最小边长（再小基本是图标/占位，识别不出正文） */
const MIN_DIMENSION = 64;

/** 二分类问法：只要一个字，省 token */
const BINARY_PROMPT = `判断这张图片里是否含有"可以用于回答提问"的信息。
可用的信息包括：文字、数字、错误提示、活动奖励内容、界面元素、游戏画面细节等。
如果整张图基本是纯色、纯装饰、看不出具体内容 → 回答 无
否则 → 回答 有
只输出一个字：「有」或「无」。`;

/**
 * 质量预筛（同步判断，不打网络）
 * @param {Array} images 规范化图片
 * @returns {{kept:Array, skipped:Array<{ref:string,reason:string}>}}
 */
export function qualityPrefilter(images, { enabled = true, minBytes = MIN_BYTES } = {}) {
  if (!enabled) return { kept: images || [], skipped: [] };
  const kept = [];
  const skipped = [];
  const seen = new Set();

  for (const img of images || []) {
    if (!img || !img.base64) {
      skipped.push({ ref: img?.ref || '?', reason: img?.error ? `download:${img.error}` : 'no-data' });
      continue;
    }
    if (img.bytes && img.bytes < minBytes) {
      skipped.push({ ref: img.ref, reason: 'too-small' });
      continue;
    }
    if (img.width && img.height && Math.max(img.width, img.height) < MIN_DIMENSION) {
      skipped.push({ ref: img.ref, reason: 'too-few-pixels' });
      continue;
    }
    // 本批去重（同一张图出现多次只识一次）
    const h = createHash('sha1').update(String(img.base64).slice(0, 2048)).digest('hex');
    if (seen.has(h)) {
      skipped.push({ ref: img.ref, reason: 'duplicate' });
      continue;
    }
    seen.add(h);
    kept.push(img);
  }
  return { kept, skipped };
}

/** 从模型回复里读「有 / 无」（容忍多余字符） */
export function parseBinaryAnswer(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  // 优先看开头的字，避免「无文字但有画面」这种长句误判
  const head = t.slice(0, 12);
  if (/无/.test(head) && !/有/.test(head)) return false;
  if (/有/.test(head)) return true;
  // 英文兜底
  if (/^(no|false|none)\b/i.test(t)) return false;
  if (/^(yes|true|has)\b/i.test(t)) return true;
  return null;
}

/**
 * VLM 二分类预筛（异步，会调模型）
 *
 * ⚠️ 先探一次渠道是否可用：**没有看图渠道就整体跳过**。
 *    不这么做的话，每张图都会去尝试一次、失败一次 —— 实测 13 张图白等 40+ 秒
 *    （2026-11-24 端到端验收发现）。
 *
 * @returns {Promise<{kept:Array, skipped:Array<{ref:string,reason:string}>}>}
 */
export async function vlmBinaryPrefilter(images, { enabled = true, config = {}, materials = [], log = () => {} } = {}) {
  const list = images || [];
  if (!enabled) return { kept: list, skipped: [] };
  if (!list.length) return { kept: [], skipped: [] };
  if (!resolveVision(config)) {
    log('  [预筛] 无可用看图渠道 → 跳过 VLM 二分类（质量预筛照常）');
    return { kept: list, skipped: [] };
  }
  const kept = [];
  const skipped = [];
  for (const img of list) {
    const r = await describeImages([img], {
      prompt: BINARY_PROMPT,
      materials,
      config,
      log,
      temperature: 0,
      maxTokens: 8,
      timeoutMs: 30000,
    });
    // 调不通/判不准 → 保留（宁可多识别）
    if (r.error) {
      kept.push(img);
      continue;
    }
    const verdict = parseBinaryAnswer(r.text);
    if (verdict === false) skipped.push({ ref: img.ref, reason: 'no-info' });
    else kept.push(img);
  }
  return { kept, skipped };
}

/**
 * 完整预筛：质量 → VLM 二分类
 * @returns {Promise<{kept:Array, skipped:Array<{ref:string,reason:string}>}>}
 */
export async function prefilter(images, { quality = true, vlmBinary = true, config = {}, materials = [], log = () => {} } = {}) {
  const q = qualityPrefilter(images, { enabled: quality });
  const v = await vlmBinaryPrefilter(q.kept, { enabled: vlmBinary, config, materials, log });
  return { kept: v.kept, skipped: [...q.skipped, ...v.skipped] };
}

export { MIN_DIMENSION, BINARY_PROMPT };