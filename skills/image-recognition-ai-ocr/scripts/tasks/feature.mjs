// T3 · 特征识别任务：图片 → 特征（非文字）
//
// 手段顺序：**模板匹配优先**（已知特征，免费、精确、可复现）
//          → VLM 描述（未知特征，计费、开放语义）。
//
// 模板库由调用方传入（`templates`）—— 本包不携带任何领域模板。
// 任务必须说明（`hint`）："识别图里的植物名称与奖励物品"，
// 不说清就退化成泛泛描述，价值低。

import { matchImage } from '../features.mjs';
import { describeImages } from '../vision.mjs';
import { cacheKey } from '../cache.mjs';
import { fingerprint } from '../image.mjs';

/** 描述长度默认值（字符）。为什么不给大：长描述要模型慢慢生成，
 *  实测 700 字能烧 50~80 秒；200 字通常十几秒，信息量对下游够用。
 *  调用方要长描述就显式传 maxDescChars。 */
export const DEFAULT_MAX_DESC_CHARS = 200;

/**
 * 由"期望字数"换算 maxTokens。
 * 中文大致 1 字 ≈ 1~1.6 token，留点余量；0/空 → 用保守默认。
 */
export function tokensForChars(chars) {
  const n = Number(chars);
  if (!Number.isFinite(n) || n <= 0) return 1200; // 不限 → 用默认预算
  return Math.min(4000, Math.max(96, Math.ceil(n * 2) + 64));
}

/**
 * 构造特征描述提示词
 * @param {string} [hint]        任务说明
 * @param {{maxDescChars?:number}} [opt] 期望字数（0/空 = 不限）
 */
export function buildFeaturePrompt(hint = '', { maxDescChars = DEFAULT_MAX_DESC_CHARS } = {}) {
  const task = hint || '描述这张图片里可见的主要对象与特征';
  // 可空：null / undefined / '' → 用默认；0 → 明确表示"不限"
  const raw = maxDescChars === null || maxDescChars === undefined || maxDescChars === ''
    ? DEFAULT_MAX_DESC_CHARS
    : Number(maxDescChars);
  const lenLine = raw > 0
    ? `- 总长度控制在 ${raw} 字以内，宁可精简也别啰嗦`
    : '- 长度不限，但只写有用信息';
  return `任务：${task}

要求：
- 只描述图中**真实可见**的特征，看不清的明确说"看不清"，不要猜、不要编造
- 先列特征（每个特征一行，尽量具体：名称/数量/数值/状态）
${lenLine}
- 不要用 markdown 标题，不要复述任务本身`;
}

/**
 * 跑特征识别任务
 * @param {Array} images 规范化+预筛后的图片
 * @param {Array} templates [{id,name,image(base64),threshold}]
 */
export async function runFeature(images, {
  hint = '',
  templates = [],
  context = '',
  materials = [],
  features = {},
  vision = {},
  visionEnabled = true,
  skipVisionFor = null, // Set<ref>：这些图不用再做 VLM 描述（OCR 已经读够了）
  maxDescChars = DEFAULT_MAX_DESC_CHARS, // 描述长度上限（字符；0 或空 = 不限）
  config = {},
  cache = null,
  log = () => {},
} = {}) {
  const results = [];
  const degraded = [];
  const methods = new Set();
  const tplIds = (templates || []).map((t) => t.id || t.name).join(',');

  for (const img of images) {
    const out = { image: img.ref, features: [], description: '', method: 'none' };

    // ① 模板匹配（通道开着 + 有模板 才跑）
    if (features.enabled !== false && (templates || []).length) {
      const key = cacheKey('feature', fingerprint(img), tplIds);
      const cached = cache?.get?.(key);
      let hits = cached?.hits || [];
      if (!cached) {
        const r = await matchImage(img, templates, { config: features, log });
        if (r.error) degraded.push(`template:${img.ref}:${r.error}`);
        hits = r.hits || [];
        cache?.set?.(key, { hits });
      }
      methods.add('template');
      if (hits.length) {
        out.features.push(
          ...hits.map((h) => ({ id: h.id || null, name: h.name || '', method: 'template', score: h.score ?? null }))
        );
        out.method = 'template';
      }
    } else if (features.enabled !== false) {
      // 通道开着但调用方没给模板 —— 说清楚，别让它以为"没识别到特征"
      degraded.push('template:no-templates');
    }

    // ② VLM 描述（读开放特征）
    //    除非这张图的文字已经被 OCR 读够了 —— 那时再花几十秒让模型"看图说话"是浪费
    const skipThis = skipVisionFor && skipVisionFor.has(img.ref);
    const wantVision = visionEnabled !== false && vision.enabled !== false && !skipThis;
    if (skipThis) degraded.push(`feature-vlm:${img.ref}:skipped-text-rich`);
    if (wantVision) {
      const key = cacheKey('feature-vlm', fingerprint(img), hint || 'default');
      const r = await describeImages([img], {
        prompt: buildFeaturePrompt(hint, { maxDescChars }),
        context,
        materials,
        config: vision,
        log,
        cacheKey: key,
        cache,
        temperature: 0.2,
        maxTokens: tokensForChars(maxDescChars),
      });
      if (r.text) {
        out.description = r.text;
        methods.add('vlm');
        if (!out.method) out.method = 'vlm';
        else out.method = `${out.method}+vlm`;
      } else if (r.error) {
        degraded.push(`feature-vlm:${img.ref}:${r.error}`);
      }
    }

    results.push(out);
  }
  // 全图都没模板也没描述 → 说清楚为什么
  if (!methods.size) degraded.push('feature:no-channel');
  return { results, degraded: [...new Set(degraded)], methods: [...methods] };
}