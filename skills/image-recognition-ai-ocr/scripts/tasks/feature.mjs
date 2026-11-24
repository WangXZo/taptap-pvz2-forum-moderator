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

/** 构造特征描述提示词 */
export function buildFeaturePrompt(hint = '') {
  const task = hint || '描述这张图片里可见的主要对象与特征';
  return `任务：${task}

要求：
- 只描述图中**真实可见**的特征，看不清的明确说"看不清"，不要猜、不要编造
- 先列特征（每个特征一行，尽量具体：名称/数量/数值/状态）
- 最后用一两句话整体说明这张图在表达什么
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

    // ① 模板匹配（有模板才跑）
    if (features.enabled !== false && (templates || []).length) {
      const key = cacheKey('feature', fingerprint(img), tplIds);
      const cached = cache?.get?.(key);
      let hits = cached?.hits || [];
      if (!cached) {
        const r = await matchImage(img, templates, { config: features, log });
        if (r.error && r.error !== 'no-templates') degraded.push(`template:${img.ref}:${r.error}`);
        hits = r.hits || [];
        cache?.set?.(key, { hits });
      }
      if (hits.length) {
        out.features.push(
          ...hits.map((h) => ({ id: h.id || null, name: h.name || '', method: 'template', score: h.score ?? null }))
        );
        out.method = 'template';
        methods.add('template');
      } else if (features.enabled !== false) {
        methods.add('template');
      }
    } else if ((templates || []).length && features.enabled === false) {
      // 显式关掉就不记 degraded
    } else if (features.enabled !== false) {
      degraded.push('template:no-templates');
    }

    // ② VLM 描述（读开放特征）
    const wantVision = visionEnabled !== false && vision.enabled !== false;
    if (wantVision) {
      const key = cacheKey('feature-vlm', fingerprint(img), hint || 'default');
      const r = await describeImages([img], {
        prompt: buildFeaturePrompt(hint),
        context,
        materials,
        config: { ...vision, chatVision: vision.chatVision },
        log,
        cacheKey: key,
        cache,
        temperature: 0.2,
        maxTokens: 1200,
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