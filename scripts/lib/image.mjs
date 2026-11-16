// 图片处理流水线（S1–S5，2026-11-16）
//
// 大哥拍板的三条规则（设计稿：任务目录 output/PVZ2图片识别-技术设计稿-20261116.md）：
//   ① 好友码/天宫码意图 → 直接跳过图片识别（走原流程，不读图）。
//   ② 其他帖先判图片相关性：无关配图跳过、相关图才识别（纯启发式起步）。
//   ③ 识别内容并入帖子内容 → 进网络搜索 + LLM 上下文（回灌 post.text）。
//
// 取图实测（evidence/06）：图在 moment.topic.footer_images[]，feed 层即带；
//   匿名+X-UA 可读；CDN 无防盗链。见 http.mjs extractImages。
//
// 纯函数为主，识别器 recognize 可注入 → 便于离线回归（不打网络/不起 Python）。

import { extractImages } from './http.mjs';
import { looksLikeCodeAsk } from './code-guard.mjs';
import { detectFriendRequest } from './mod-task.mjs';
import { looksLikeQuestion } from './qa.mjs';

/**
 * 规则1：码/好友意图 → 跳过图片识别。
 * 复用现有判定：looksLikeCodeAsk（求码）+ detectFriendRequest（加好友）。
 * @returns {{skip:boolean, reason?:string}}
 */
export function isCodeIntent({ title = '', text = '' } = {}, config = {}) {
  const blob = `${title || ''}\n${text || ''}`;
  if (looksLikeCodeAsk(blob)) return { skip: true, reason: '求码帖' };
  const fr = detectFriendRequest({
    title,
    text,
    bareCodeIsIntent: config?.image?.bareCodeIsIntent ?? true,
  });
  if (fr?.hit) return { skip: true, reason: `好友意图(${fr.confidence || 'hit'})` };
  return { skip: false };
}

/**
 * 规则2：相关性门控（纯启发式起步，VLM 二分类按需后开）。
 * @returns {'none'|'relevant'|'decorative'|'unknown'}
 *   none      无图
 *   relevant  相关图（求助意图 / 正文短信息可能在图里）→ 识别
 *   decorative 无关配图（正文已长且明确）→ 跳过
 *   unknown   判不明 → 起步按相关处理（宁可多识别不漏信息，可配）
 */
export function imageRelevance({ title = '', text = '', images = [] } = {}, config = {}) {
  if (!images.length) return 'none';
  const cfg = config?.image?.relevanceGate || {};
  const body = `${title || ''} ${text || ''}`.replace(/\s+/g, ' ').trim();
  const len = body.length;
  const shortText = Number(cfg.shortTextLen ?? 30);
  const longText = Number(cfg.longTextLen ?? 120);
  const unknownAsRelevant = cfg.unknownAsRelevant !== false;
  if (looksLikeQuestion(body)) return 'relevant';
  if (len <= shortText) return 'relevant';
  if (len >= longText) return 'decorative';
  return unknownAsRelevant ? 'relevant' : 'unknown';
}

/**
 * 默认识别器：S6 模板匹配（本地免费）→ S3 OCR（文字）→ S4 VLM（语义）。
 * 各模块惰性 import + 失败降级（缺依赖/无渠道不抛错，返回已拿到的部分）。
 * 识别器契约：async (images, {config,log,title,text,cache}) → {text, sources:[...]}
 */
export async function defaultRecognize(images, { config = {}, log = () => {}, cache = null } = {}) {
  const parts = [];
  const sources = [];
  const ic = config?.image || {};

  // S6 模板匹配（本地特征库，优先免费快）
  if (ic.features?.enabled) {
    try {
      const { matchFeatures } = await import('./features.mjs');
      const r = await matchFeatures(images, { config, log });
      if (r?.text) {
        parts.push(r.text);
        sources.push('template');
      }
    } catch (e) {
      log(`  [图片] 模板匹配跳过：${e.message}`);
    }
  }

  // S3 OCR（文字/数字/说明文本）
  if (ic.ocr?.enabled !== false) {
    try {
      const { ocrImages } = await import('./ocr.mjs');
      const r = await ocrImages(images, { config, log, cache });
      if (r?.text) {
        parts.push(r.text);
        sources.push('ocr');
      }
    } catch (e) {
      log(`  [图片] OCR 跳过：${e.message}`);
    }
  }

  // S4 VLM（游戏画面/开放语义）
  if (ic.vision?.enabled !== false) {
    try {
      const { describeImages } = await import('./vision.mjs');
      const r = await describeImages(images, { config, log, cache });
      if (r?.text) {
        parts.push(r.text);
        sources.push('vlm');
      }
    } catch (e) {
      log(`  [图片] VLM 跳过：${e.message}`);
    }
  }

  return { text: parts.join('\n').trim(), sources };
}

/**
 * 主流水线：取图 → 意图门控 → 相关性门控 → 识别 → 回灌文本。
 * @param item feed list item（含 moment.topic.footer_images）
 * @param opts {config, log, title, text, recognize?, cache?}
 * @returns {{text:string, imageText:string, images:Array, relevance:string, skipped:string, sources:Array}}
 *   text = 回灌后的帖子文本（baseText + 图片内容）；skipped 非空表示未识别（含原因）。
 */
export async function enrichPostImages(item, { config = {}, log = () => {}, title = '', text = '', recognize = null, cache = null } = {}) {
  const images = extractImages(item);
  const base = { images, imageText: '', relevance: 'none', skipped: '', sources: [] };
  if (config?.image?.enabled === false) return { ...base, text, skipped: 'disabled' };
  if (!images.length) return { ...base, text, skipped: 'no-image' };

  // 规则1：码/好友意图跳过
  const intent = isCodeIntent({ title, text }, config);
  if (intent.skip) return { ...base, text, skipped: `code-intent:${intent.reason}` };

  // 规则2：相关性门控
  const relevance = imageRelevance({ title, text, images }, config);
  if (relevance === 'decorative') return { ...base, text, relevance, skipped: 'decorative' };
  if (relevance === 'unknown') return { ...base, text, relevance, skipped: 'unknown' };

  // 识别（可注入）
  const rec = recognize || defaultRecognize;
  let result;
  try {
    result = await rec(images, { config, log, title, text, cache });
  } catch (e) {
    log(`  [图片] 识别异常：${e.message} → 跳过`);
    return { ...base, text, relevance, skipped: `error:${e.message}` };
  }
  const imageText = String(result?.text || '').trim();
  const sources = result?.sources || [];
  if (!imageText) return { ...base, text, relevance, skipped: 'empty-recognition', sources };

  // 规则3：回灌（识别内容并入帖子文本，下游 QA/搜索/组答自动受益）
  const merged = `${text || ''}\n[图片内容] ${imageText}`.trim();
  return { text: merged, imageText, images, relevance: 'relevant', skipped: '', sources };
}