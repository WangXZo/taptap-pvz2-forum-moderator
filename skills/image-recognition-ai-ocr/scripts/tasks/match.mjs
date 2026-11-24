// T1 · 判断类任务：图片是否匹配某个意图 → 返回置信度
//
// 大哥要求：返回**置信度**（不是布尔）；默认返回全部意图的置信度，
// `onlyBest: true` 时只返最高分那个。
//
// 为什么要置信度：下游可能要做多标签（一张图既是「活动页」又是「含奖励」），
// 也可能要高阈值过滤；给布尔就把判断权锁死在识图侧了。

import { describeImages } from '../vision.mjs';
import { tryParseJson, toConfidence, str } from '../json.mjs';
import { cacheKey } from '../cache.mjs';
import { fingerprint } from '../image.mjs';

/** 构造判定提示词 */
export function buildMatchPrompt(intents, { hint = '' } = {}) {
  const lines = intents.map((it, i) => `${i + 1}. id="${it.id}"  含义：${it.label || it.id}${it.description ? `  补充：${it.description}` : ''}`);
  return [
    '任务：判断这张图片与下列每个「意图」的匹配程度。',
    '',
    '意图清单：',
    ...lines,
    '',
    hint ? `补充说明：${hint}` : '',
    '',
    '要求：',
    '- 对**每一个**意图都给出 0~1 的置信度（1 = 完全符合，0 = 完全不符合）',
    '- 置信度要拉开差距，不要所有意图都给一个差不多的值',
    '- reason 里写你看到的**具体可见元素**作为依据，不要只写结论',
    '- 只输出 JSON，不要任何解释文字',
    '',
    '输出格式：',
    '{"matches":[{"intent":"<上面某个 id>","confidence":0.0,"reason":"..."}]}',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/** 规范化模型返回的判定结果 */
export function normalizeMatchResult(parsed, intents, { onlyBest = false } = {}) {
  const valid = new Set(intents.map((i) => String(i.id)));
  const labelOf = new Map(intents.map((i) => [String(i.id), i.label || i.id]));
  const raw = Array.isArray(parsed?.matches) ? parsed.matches : [];
  const out = [];
  const seen = new Set();
  for (const m of raw) {
    const intent = str(m?.intent ?? m?.id ?? m?.label, 64);
    if (!intent || !valid.has(intent) || seen.has(intent)) continue;
    seen.add(intent);
    out.push({
      intent,
      label: labelOf.get(intent) || intent,
      confidence: toConfidence(m?.confidence ?? m?.score ?? m?.conf),
      reason: str(m?.reason ?? m?.why, 300),
    });
  }
  // 模型漏答的意图补 0 置信度（下游能看到"没被判过"，而不是凭空消失）
  for (const it of intents) {
    const id = String(it.id);
    if (!seen.has(id)) {
      out.push({ intent: id, label: it.label || id, confidence: 0, reason: '' , missing: true });
    }
  }
  out.sort((a, b) => b.confidence - a.confidence);
  return onlyBest ? out.slice(0, 1) : out;
}

/**
 * 跑判断任务
 * @param {Array} images 规范化+预筛后的图片
 * @param {Array} intents [{id,label,description}]
 * @returns {Promise<{results:Array, degraded:string[], methods:string[]}>}
 */
export async function runMatch(images, { intents = [], onlyBest = false, hint = '', context = '', materials = [], config = {}, cache = null, log = () => {} } = {}) {
  const results = [];
  const degraded = [];
  const methods = new Set();

  if (!Array.isArray(intents) || !intents.length) {
    return { results: [], degraded: ['match:no-intents'], methods: [] };
  }

  const prompt = buildMatchPrompt(intents, { hint });

  for (const img of images) {
    const key = cacheKey('match', fingerprint(img), JSON.stringify(intents.map((i) => i.id)) + (onlyBest ? '|best' : ''));
    const r = await describeImages([img], { prompt, context, materials, config, log, cacheKey: key, cache, temperature: 0.1, maxTokens: 800 });
    if (r.error) {
      degraded.push(`match:${img.ref}:${r.error}`);
      continue;
    }
    methods.add('vlm');
    const parsed = tryParseJson(r.text);
    if (!parsed) {
      degraded.push(`match:${img.ref}:unparsable`);
      continue;
    }
    for (const m of normalizeMatchResult(parsed, intents, { onlyBest })) {
      results.push({ image: img.ref, ...m });
    }
  }
  return { results, degraded, methods: [...methods] };
}