// VLM 通道：图片 → 语义（判断 / 兜底读字 / 特征描述）
//
// 渠道解析是**三级**，优先级从高到低（与 taptap 版主 skill 的 LLM 同一套思路）：
//
//   ① 注入     调用方传 options.vision.chatVision
//              —— 复用调用方自己的模型路由/配额，最省事
//   ② 自备 KEY  options.vision.{apiKey,baseURL,model}
//              或环境变量 IR_VISION_API_KEY / IR_VISION_BASE_URL / IR_VISION_MODEL
//              （也接受 OPENAI_API_KEY / OPENAI_BASE_URL 兜底命名）
//              —— **给别人用**：谁都能填自己的 key，本 skill 独立可跑
//   ③ 复用 DSH  读 ~/.dsh/profiles/{web,default}/cordis.patch.yml + .credentials.yaml
//              按能力词（vl / vision / omni / multimodal）挑视觉模型，**不写死任何模型名**
//              —— **跟随宿主**：在 DSH 里换模型，本 skill 自动跟着换
//
//   都没有 → 降级跳过，写进 degraded: ['vlm:no-channel']
//
// ⚠️ 凭据只在内存里用，不落盘、不打印、不进日志。

import { formatMaterials } from './materials.mjs';
import { loadDshRoutes } from './dsh-routes.mjs';

/** 一次多模态调用最多带几张图（防止 prompt 过大） */
const MAX_IMAGES_PER_CALL = 4;

/** 视觉能力判定：优先看 DSH 里声明的输入能力，其次白名单，最后才按名字能力词猜 */
const VISION_RE = /vl|vision|omni|multimodal/i;
/** DSH 配置里表示"能输入图片"的写法 */
const IMAGE_INPUTS = new Set(['image', 'img', 'image_url', 'vision', 'picture', 'images']);

/**
 * 这个模型能不能看图？
 *
 * 依据顺序（前面的更权威）：
 *   ① 白名单 config.visionModels —— 显式指定，一票通过
 *   ② DSH 声明的 input 能力 —— 配置里写了 `- image` 就是能（**这是主要依据**）
 *   ③ 名字能力词（vl/vision/omni/multimodal）—— 没声明时的兜底猜测
 *
 * 为什么以声明为准：用户 2026-11-24 反馈「DSH 我配置的 LLM 大部分都支持图片」——
 * 那些模型名（qwen3.8-max / glm-5.3 / kimi-k3…）**不带** vl/omni 字样，
 * 只靠名字猜会全部漏掉。DSH 配置里 `input: [text, image]` 才是权威答案。
 *
 * @param {string|object} model 模型 id 或 DSH 里的模型对象 {id, input[]}
 */
export function supportsImageInput(model, config = {}) {
  const id = typeof model === 'string' ? model : model?.id;
  const wl = config?.visionModels || config?.vision?.models;
  if (Array.isArray(wl) && id && wl.includes(id)) return true;
  const declared = model && typeof model === 'object' && Array.isArray(model.input) ? model.input : null;
  if (declared && declared.length) {
    return declared.some((x) => IMAGE_INPUTS.has(String(x).toLowerCase()));
  }
  return VISION_RE.test(String(id || ''));
}

/** 兼容名（旧代码叫 isVisionModel） */
export function isVisionModel(model, config = {}) {
  return supportsImageInput(model, config);
}

/** ② 自备 KEY：从 config 或环境变量解析 */
export function resolveOwnKey(config = {}, env = config.env || process.env) {
  const v = config || {};
  if (v.apiKey && v.baseURL && v.model) {
    return {
      source: 'config',
      provider: 'custom-vision',
      model: v.model,
      api: v.api || 'openai-completions',
      baseURL: String(v.baseURL).replace(/\/$/, ''),
      apiKey: v.apiKey,
      maxTokens: Number(v.maxTokens || 1200),
    };
  }
  const apiKey = env.IR_VISION_API_KEY || env.OPENAI_API_KEY || '';
  const baseURL = (env.IR_VISION_BASE_URL || env.OPENAI_BASE_URL || '').replace(/\/$/, '');
  const model = env.IR_VISION_MODEL || env.OPENAI_MODEL || '';
  if (!apiKey || !baseURL || !model) return null;
  return {
    source: 'env',
    provider: 'env-vision',
    model,
    api: env.IR_VISION_API || 'openai-completions',
    baseURL,
    apiKey,
    maxTokens: Number(v.maxTokens || 1200),
  };
}

/**
 * ③ 复用 DSH 路由：挑 vision-capable 模型
 * 顺序：DSH chain 里出现过的 provider 优先，其余按配置顺序补在后面（不在本 skill 排序/写死模型名）
 */
export async function resolveDshVisionChannels(config = {}, routes = null) {
  const dsh = routes || (await loadDshRoutes());
  if (!dsh.hasPatch) return [];
  const want = config.model || '';
  const order = [...new Set(dsh.chain.map((c) => c.provider))];
  for (const pid of Object.keys(dsh.providers)) if (!order.includes(pid)) order.push(pid);

  const out = [];
  const seen = new Set();
  for (const pid of order) {
    const p = dsh.providers[pid];
    if (!p || !p.baseURL) continue;
    const key = dsh.creds[p.apiKeyEnv];
    if (!key) continue; // 这条渠道没凭据 → 跳过（让别人接管）
    const pool = p.models || [];
    let picked = want ? pool.filter((m) => (typeof m === 'string' ? m : m.id) === want) : pool.filter((m) => supportsImageInput(m, config));
    // 同一个 provider 内部：**DSH chain 里点过名的模型排前面**（chain 顺序），其余按配置顺序补后
    if (!want) {
      const chainPos = new Map();
      dsh.chain.forEach((c, i) => {
        if (c.provider === pid && c.model && !chainPos.has(c.model)) chainPos.set(c.model, i);
      });
      const idOf = (m) => (typeof m === 'string' ? m : m.id);
      picked = picked
        .map((m, i) => ({ m, i, pos: chainPos.has(idOf(m)) ? chainPos.get(idOf(m)) : 1e9 }))
        .sort((a, b) => a.pos - b.pos || a.i - b.i)
        .map((x) => x.m);
    }
    for (const m of picked) {
      const model = typeof m === 'string' ? m : m.id;
      if (!model) continue;
      if (!want && !supportsImageInput(m, config)) continue;
      const sig = `${pid}/${model}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({
        source: 'dsh',
        provider: pid,
        model,
        api: p.api || 'openai-completions',
        baseURL: String(p.baseURL).replace(/\/$/, ''),
        apiKey: key,
        maxTokens: Number(config.maxTokens || 1200),
      });
    }
  }
  return out;
}

/**
 * 组装视觉渠道列表（不含注入式）
 * @returns {Promise<Array>}
 */
export async function resolveVisionChannels(config = {}) {
  const out = [];
  const own = resolveOwnKey(config);
  if (own) out.push(own);
  if (config.reuseDsh !== false) {
    try {
      out.push(...(await resolveDshVisionChannels(config)));
    } catch {
      /* DSH 配置读不到 → 只靠前面那些 */
    }
  }
  return out;
}

/** 中性多模态 content → 各 API 风格 */
export function toApiContent(content, api) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.map((b) => {
    if (!b || typeof b !== 'object') return { type: 'text', text: String(b ?? '') };
    if (b.type === 'image') {
      const mediaType = b.mediaType || 'image/jpeg';
      if (api === 'anthropic-messages') {
        const source = b.base64
          ? { type: 'base64', media_type: mediaType, data: b.base64 }
          : { type: 'url', url: b.url };
        return { type: 'image', source };
      }
      return { type: 'image_url', image_url: { url: b.url || `data:${mediaType};base64,${b.base64}` } };
    }
    return { type: 'text', text: b.text || '' };
  });
}

/** 单渠道发一次请求（两种线上风格） */
export async function callOnce(ch, { system = '', messages = [], temperature = 0.2, maxTokens = 1200, timeoutMs = 90000 } = {}) {
  const msgs = (messages || []).map((m) => ({ role: m.role, content: toApiContent(m.content, ch.api) }));
  const ctrl = new AbortController();
  // anthropic 风格渠道会强制 thinking，思考长度波动大（实测 11~60s）→ 给更宽的超时
  const budget = ch.api === 'anthropic-messages' ? Math.max(timeoutMs || 0, 150000) : timeoutMs || 60000;
  const timer = setTimeout(() => ctrl.abort(), budget);
  try {
    if (ch.api === 'anthropic-messages') {
      const res = await fetch(`${ch.baseURL}/v1/messages`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': ch.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: ch.model,
          // anthropic 风格强制 thinking，给小了只会拿到 thinking、正文为空
          max_tokens: Math.max(maxTokens, 8000),
          temperature,
          system,
          messages: msgs,
        }),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
      const j = JSON.parse(text);
      // anthropic 的 content 块**没有 type 字段**：thinking 块带 signature，正文块带 text。
      // 只认 type==='text' 会把答案全丢掉 —— 所以取"有 text 且不是 thinking"的块拼起来。
      const blocks = Array.isArray(j.content) ? j.content : [];
      const out = blocks
        .filter((b) => b && typeof b === 'object' && typeof b.text === 'string' && b.text && !b.thinking)
        .map((b) => b.text)
        .join('');
      return { ok: true, text: out, raw: j };
    }
    // openai-completions（含 ollama 的 /v1）
    const res = await fetch(`${ch.baseURL}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ch.apiKey}` },
      body: JSON.stringify({ model: ch.model, temperature, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...msgs] }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
    const j = JSON.parse(text);
    const c = j?.choices?.[0]?.message?.content;
    const out = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('') : '';
    return { ok: true, text: out, raw: j };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拿一个可用的看图调用器
 *
 * 顺序：注入优先，**注入失败自动回落到自带/DSH 渠道**。
 * 为什么要回落：调用方注入的那套可能按模型名筛视觉能力（漏掉不带 vl/omni 字样的通用 LLM），
 * 结果"注入了但一条渠道都没有"—— 如果不回落，就会白白降级，而本 skill 自己明明能挑到渠道。
 *
 * @returns {Promise<{chat:Function, model:string, source:string, channels?:Array}|null>}
 */
export async function resolveVision(config = {}) {
  const injected = typeof config.chatVision === 'function' ? config.chatVision : null;
  const channels = await resolveVisionChannels(config);
  if (!injected && !channels.length) return null;

  return {
    channels,
    model: channels[0]?.model || String(config.model || 'injected'),
    source: injected ? 'injected' : channels[0].source,
    chat: async (_cfg, opts) => {
      let last = null;
      // ① 注入优先
      if (injected) {
        const r = await injected(_cfg, opts);
        if (r?.ok && String(r.text || '').trim()) return r;
        last = r;
      }
      // ② 注入不可用/失败 → 自带 KEY 与 DSH 渠道兜底
      for (const ch of channels) {
        const r = await callOnce(ch, { ...opts, maxTokens: opts?.maxTokens || ch.maxTokens });
        if (r.ok && String(r.text || '').trim()) return { ...r, channel: ch.provider, model: ch.model };
        last = r;
      }
      return { ok: false, error: last?.error || '所有视觉渠道都失败', status: last?.status };
    },
  };
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
 * @param {string} o.prompt    任务提示词
 * @param {string} [o.context] 调用方给的背景资料
 * @param {Array}  [o.materials] 已加载的资料
 * @param {object} [o.config]  渠道配置（chatVision / apiKey+baseURL+model / env / reuseDsh / model）
 * @returns {Promise<{text:string, model:string, ms:number, error?:string, cached?:boolean}>}
 */
export async function describeImages(
  images,
  { prompt = '', context = '', materials = [], config = {}, log = () => {}, temperature = 0.2, maxTokens = 1200, timeoutMs = 90000, cacheKey = null, cache = null } = {}
) {
  const t0 = Date.now();
  const list = (images || []).filter((i) => i && i.base64);
  if (!list.length) return { text: '', model: '', ms: 0, error: 'no-image' };

  const v = await resolveVision(config);
  if (!v) {
    log('  [VLM] 无可用看图渠道（未注入、未配 KEY、DSH 里也没有视觉模型）→ 跳过');
    return { text: '', model: '', ms: 0, error: 'no-channel' };
  }

  if (cacheKey && cache) {
    const hit = cache.get(cacheKey);
    if (hit) return { text: hit.text || '', model: hit.model || v.model, ms: 0, cached: true };
  }

  // 拼系统提示：任务提示 + 知识资料 + 背景
  const sysParts = ['你要看图回答任务，只描述图中真实可见的内容，看不清的不要猜、不要编造。'];
  if (prompt) sysParts.push(prompt);
  const matText = formatMaterials(materials);
  if (matText) sysParts.push(`【参考资料】\n${matText}`);
  if (context) sysParts.push(`【任务背景】\n${context}`);

  const r = await v.chat(config, {
    system: sysParts.join('\n\n'),
    messages: [{ role: 'user', content: toContent(list, '请看图，按上述任务要求作答。') }],
    temperature,
    maxTokens,
    timeoutMs,
  });

  if (!r?.ok) {
    log(`  [VLM] 调用失败：${r?.error || 'unknown'}`);
    return { text: '', model: v.model, ms: Date.now() - t0, error: r?.error || 'failed' };
  }
  const out = { text: String(r.text || '').trim(), model: r.model || v.model, source: v.source, ms: Date.now() - t0 };
  if (cacheKey && cache) cache.set(cacheKey, { text: out.text, model: out.model });
  return out;
}

export { MAX_IMAGES_PER_CALL };