// T1 · 判断类任务：图片是否匹配某个意图 → 返回置信度
//
// 大哥要求：返回**置信度**（不是布尔）；默认返回全部意图的置信度，
// `onlyBest: true` 时只返最高分那个。
//
// 为什么要置信度：下游可能要做多标签（一张图既是「活动页」又是「含奖励」），
// 也可能要高阈值过滤；给布尔就把判断权锁死在识图侧了。
//
// 2026-11-25 提速（大哥："仅为判断，一句话足够，每图时间最短"）：
//   ① **不注入资料/背景**（materials/context 不传）—— 提示词越短首字越快
//   ② reason 只留一句话（≤20 字）—— 别让模型罗列可见元素
//   ③ maxTokens 按意图数给（每个意图约 48 token），不再固定 800
//   ④ 明确"不读图里的文字、不描述画面" —— 少生成就少等

import { describeImages } from '../vision.mjs';
import { tryParseJson, toConfidence, str, salvageJsonObjects } from '../json.mjs';
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
    '- 对**每一个**意图都给 0~1 的置信度（1 = 完全符合，0 = 完全不符合）',
    '- 只做判断：不要读图中的文字、不要描述画面、不要罗列可见元素',
    '- 置信度要拉开差距，不要所有意图都给一个差不多的值',
    '- reason **只写一句话，不超过 20 字**',
    '- 只输出 JSON，不要任何解释文字',
    '',
    '输出格式：',
    '{"matches":[{"intent":"<上面某个 id>","confidence":0.0,"reason":"..."}]}',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/** 判定任务的输出预算：一个意图约 100 token（id + 置信度 + 20 字理由 + JSON 结构），
 *  下限 320（实测 3 意图出满要 ~200 token，留足余量免得被截断），上限 1200 */
export function matchMaxTokens(intentCount = 1) {
  return Math.min(1200, Math.max(320, 140 + Math.max(1, Number(intentCount) || 1) * 100));
}

/** 看起来像一条判定结果的对象（模型漏掉外层数组时也能认出来） */
function looksLikeMatchItem(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const hasId = o.intent !== undefined || o.id !== undefined || o.label !== undefined;
  const hasScore = o.confidence !== undefined || o.score !== undefined || o.conf === undefined;
  return hasId && hasScore;
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
export async function runMatch(images, { intents = [], onlyBest = false, hint = '', config = {}, cache = null, log = () => {} } = {}) {
  const results = [];
  const degraded = [];
  const methods = new Set();

  if (!Array.isArray(intents) || !intents.length) {
    return { results: [], degraded: ['match:no-intents'], methods: [] };
  }

  const prompt = buildMatchPrompt(intents, { hint });
  // 判定只要"够判断"的输出预算：给多了模型会开始啰嗦，反而更慢
  const maxTokens = matchMaxTokens(intents.length);

  for (const img of images) {
    // 缓存签名要带上 hint —— 同图同意图但判定说明不同，答案可能不同
    const sig = JSON.stringify(intents.map((i) => i.id)) + (onlyBest ? '|best' : '') + '|' + (hint || '');
    const key = cacheKey('match', fingerprint(img), sig);
    // 注意：不传 materials / context —— 判定只看图，别把资料塞进提示词拖慢首字
    const r = await describeImages([img], { prompt, config, log, cacheKey: key, cache, temperature: 0, maxTokens });
    if (r.error) {
      degraded.push(`match:${img.ref}:${r.error}`);
      continue;
    }
    methods.add('vlm');
    // 模型偶尔把 JSON 截断（撞 maxTokens）或多说两句：先常规解析，失败就抢救完整对象
    let parsed = tryParseJson(r.text);
    if (!parsed || !Array.isArray(parsed.matches)) {
      const items = salvageJsonObjects(r.text).filter(looksLikeMatchItem);
      if (!items.length) {
        degraded.push(`match:${img.ref}:unparsable`);
        continue;
      }
      parsed = { matches: items };
      degraded.push(`match:${img.ref}:salvaged`);
      log(`  [判定] ${img.ref} JSON 不完整 → 抢救出 ${items.length} 条`);
    }
    for (const m of normalizeMatchResult(parsed, intents, { onlyBest })) {
      results.push({ image: img.ref, ...m });
    }
  }
  return { results, degraded, methods: [...methods] };
}