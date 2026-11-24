// VLM 通道：图片 → 语义（判断 / 兜底读字 / 特征描述）
//
// 渠道解析顺序（三级）：
//   ① 调用方注入 options.vision.chatVision   —— 复用调用方的模型渠道（最推荐）
//   ② 本包自带的最小 OpenAI 兼容客户端        —— 读环境变量，独立可用
//        IR_VISION_API_KEY / IR_VISION_BASE_URL / IR_VISION_MODEL
//        （也接受 OPENAI_API_KEY / OPENAI_BASE_URL 作为兜底命名）
//   ③ 都没有 → 降级跳过，写进 degraded: ['vlm:no-channel']
//
// 为什么自带一个：本 skill 要能**独立使用**（不依赖任何调用方）。
// 但自带的不碰调用方的路由/配额逻辑 —— 调用方想用自己那套就注入。

import { formatMaterials } from './materials.mjs';

/** 一次多模态调用最多带几张图（防止 prompt 过大） */
const MAX_IMAGES_PER_CALL = 4;

/** 解析内置渠道（环境变量） */
export function resolveBuiltinChannel(env = process.env) {
  const apiKey = env.IR_VISION_API_KEY || env.OPENAI_API_KEY || '';
  const baseURL = (env.IR_VISION_BASE_URL || env.OPENAI_BASE_URL || '').replace(/\/$/, '');
  const model = env.IR_VISION_MODEL || '';
  if (!apiKey || !baseURL || !model) return null;
  return { apiKey, baseURL, model };
}

/** 内置客户端：调 OpenAI 兼容的 chat/completions（多模态） */
async function builtinChatVision(channel, { system = '', messages = [], temperature = 0.2, maxTokens = 1200, timeoutMs = 90000 } = {}) {
  const body = {
    model: channel.model,
    temperature,
    max_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, ...messages],
  };
  try {
    const r = await fetch(`${channel.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${channel.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const txt = await r.text();
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} ${txt.slice(0, 200)}` };
    const j = JSON.parse(txt);
    const content = j?.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c.text || '').join('') : '';
    if (!text) return { ok: false, error: '空回复' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 拿一个可用的看图调用器
 * @returns {{chat:Function, model:string, source:'injected'|'builtin'}|null}
 */
export function resolveVision(config = {}) {
  if (typeof config.chatVision === 'function') {
    return {
      chat: (cfg, opts) => config.chatVision(cfg, opts),
      model: String(config.model || 'injected'),
      source: 'injected',
    };
  }
  const ch = resolveBuiltinChannel(config.env || process.env);
  if (ch) {
    return {
      chat: (_cfg, opts) => builtinChatVision(ch, opts),
      model: ch.model,
      source: 'builtin',
    };
  }
  return null;
}

/** 把规范化图片拼成多模态 content 块 */
function toContent(images, text) {
  const content = [{ type: 'text', text }];
  for (const img of (images || []).slice(0, MAX_IMAGES_PER_CALL)) {
    if (!img.base64) continue;
    content.push({
      type: 'image',
      base64: img.base64,
      mediaType: `image/${img.format === 'jpg' || !img.format ? 'jpeg' : img.format}`,
    });
  }
  return content;
}

/**
 * 看图说话（一次调用，多图合并 —— 省成本）
 *
 * @param {Array} images 规范化图片
 * @param {object} o
 * @param {string} o.prompt    任务提示词（已含任务说明）
 * @param {string} [o.context] 调用方给的背景资料
 * @param {Array}  [o.materials] 已加载的资料
 * @param {object} [o.config]  渠道配置（chatVision / env / model）
 * @returns {Promise<{text:string, model:string, ms:number, error?:string}>}
 */
export async function describeImages(images, { prompt = '', context = '', materials = [], config = {}, log = () => {}, temperature = 0.2, maxTokens = 1200, timeoutMs = 90000, cacheKey = null, cache = null } = {}) {
  const t0 = Date.now();
  const list = (images || []).filter((i) => i && i.base64);
  if (!list.length) return { text: '', model: '', ms: 0, error: 'no-image' };

  const v = resolveVision(config);
  if (!v) {
    log('  [VLM] 无可用看图渠道（未注入且未配置环境变量）→ 跳过');
    return { text: '', model: '', ms: 0, error: 'no-channel' };
  }

  if (cacheKey && cache) {
    const hit = cache.get(cacheKey);
    if (hit) return { text: hit.text || '', model: hit.model || v.model, ms: 0, cached: true };
  }

  // 拼系统提示：任务提示 + 背景资料 + 知识资料
  const sysParts = ['你要看图回答任务，只描述图中真实可见的内容，看不清的不要猜、不要编造。'];
  if (prompt) sysParts.push(prompt);
  const matText = formatMaterials(materials);
  if (matText) sysParts.push(`【参考资料】\n${matText}`);
  if (context) sysParts.push(`【任务背景】\n${context}`);

  const userText = '请看图，按上述任务要求作答。';
  const r = await v.chat(config, {
    system: sysParts.join('\n\n'),
    messages: [{ role: 'user', content: toContent(list, userText) }],
    temperature,
    maxTokens,
    timeoutMs,
  });

  if (!r?.ok) {
    log(`  [VLM] 调用失败：${r?.error || 'unknown'}`);
    return { text: '', model: v.model, ms: Date.now() - t0, error: r?.error || 'failed' };
  }
  const out = { text: String(r.text || '').trim(), model: v.model, source: v.source, ms: Date.now() - t0 };
  if (cacheKey && cache) cache.set(cacheKey, { text: out.text, model: out.model });
  return out;
}

export { builtinChatVision, MAX_IMAGES_PER_CALL };