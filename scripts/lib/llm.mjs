// LLM 客户端（2026-11-04）
//
// 用户要求：「远程模型，现在会话使用了多远程付费模型智能路由。我希望复用 DSH 的配置
//            而不是单独提供。但注意需要能让其他人可以通过提供 API Key 的方式使用。」
//
// 所以解析顺序是：
//   ① 技能自己的 config.llm（apiKey/baseURL/model 三项齐全）→ 直接用 —— **给别人用**的路子
//   ② 否则读 DSH 的模型路由配置：
//        ~/.dsh/profiles/web/cordis.patch.yml  → providers（baseURL / api 风格 / 模型清单）
//        ~/.dsh/.credentials.yaml              → refs 里的 API Key
//      按 llm-failover 的 chain 顺序依次尝试 —— **给自己用**的路子
//   ③ 都没有 → 返回 null，调用方降级（不发 / 转人工），绝不瞎编
//
// 支持两种线上风格：
//   openai-completions → POST {baseURL}/chat/completions   Authorization: Bearer
//   anthropic-messages → POST {baseURL}/v1/messages        x-api-key + anthropic-version
//
// ⚠️ 凭证只在内存里用，不落盘、不打印、不进日志。

import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { SKILL_ROOT } from './paths.mjs';

const DSH_DIR = join(homedir(), '.dsh');
const PATCH_PATHS = [
  join(DSH_DIR, 'profiles', 'web', 'cordis.patch.yml'),
  join(DSH_DIR, 'profiles', 'default', 'cordis.patch.yml'),
];
const CRED_PATH = join(DSH_DIR, '.credentials.yaml');

/** 极简 YAML 读取：只取 `refs:` 段下的 `KEY: value`（够用，不引依赖） */
function parseCredRefs(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  let inRefs = false;
  for (const line of lines) {
    if (/^refs\s*:/.test(line)) {
      inRefs = true;
      continue;
    }
    if (!inRefs) continue;
    // refs 段结束：出现新的顶层键（顶格且不是注释/空行）
    if (/^\S/.test(line) && !/^\s*#/.test(line)) break;
    const m = line.match(/^\s+([A-Za-z0-9_\-]+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v && v !== '~' && v !== 'null') out[m[1]] = v;
  }
  return out;
}

/** 从 patch.yml 里抠出 llm-pi-ai 的 providers 与 llm-failover 的 chain（只做够用的行解析） */
function parseProviders(text) {
  const providers = {};
  let chain = [];
  const lines = String(text || '').split(/\r?\n/);

  // providers: 每个 provider 是 6 空格缩进的 `name:`，其下有 apiKeyEnv / api / baseURL / models
  let cur = null;
  let inProviders = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s{4}providers:\s*$/.test(line)) {
      inProviders = true;
      continue;
    }
    if (inProviders && /^\s{4}\S/.test(line) && !/^\s{4}providers:/.test(line)) inProviders = false;
    if (!inProviders) continue;
    const pm = line.match(/^\s{6}([A-Za-z0-9_\-]+):\s*$/);
    if (pm) {
      cur = pm[1];
      providers[cur] = { id: cur, apiKeyEnv: '', api: '', baseURL: '', models: [] };
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^\s{8}(apiKeyEnv|api|baseURL|displayName):\s*(.+?)\s*$/);
    if (kv) {
      providers[cur][kv[1]] = kv[2].replace(/^["']|["']$/g, '');
      continue;
    }
    const mm = line.match(/^\s{10}-?\s*id:\s*(.+?)\s*$/);
    if (mm) providers[cur].models.push(mm[1].replace(/^["']|["']$/g, ''));
  }

  // chain: llm-failover 下的 `- provider: X` + 下一行 `model: Y`
  const chainStart = lines.findIndex((l) => /^\s*chain:\s*$/.test(l));
  if (chainStart >= 0) {
    for (let i = chainStart + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s{0,10}\S/.test(l) && !/^\s*-\s/.test(l) && !/^\s{10,}/.test(l)) break;
      const p = l.match(/^\s*-\s*provider:\s*(\S+)/);
      if (p) {
        const m = (lines[i + 1] || '').match(/^\s*model:\s*(\S+)/);
        chain.push({ provider: p[1], model: m ? m[1] : '' });
      }
    }
  }
  // 默认模型：找 `id: agent-default-model` 那一段，往下几行里的 provider/model
  // （别用大正则跨整文件捞 —— 很容易捞到别的 provider 块里去）
  let defaultEntry = null;
  const di = lines.findIndex((l) => /^\s*-?\s*id:\s*agent-default-model\s*$/.test(l));
  if (di >= 0) {
    for (let i = di + 1; i < Math.min(di + 8, lines.length); i++) {
      const p = lines[i].match(/^\s*provider:\s*(\S+)/);
      const m = lines[i].match(/^\s*model:\s*(\S+)/);
      if (p && !defaultEntry) defaultEntry = { provider: p[1], model: '' };
      if (m && defaultEntry && !defaultEntry.model) defaultEntry.model = m[1];
      if (defaultEntry?.provider && defaultEntry?.model) break;
    }
  }
  if (defaultEntry?.provider) chain.unshift(defaultEntry);

  return { providers, chain };
}

/** 读 DSH 配置（缓存一次） */
let _dshCache = null;
export async function loadDshLLMConfig() {
  if (_dshCache) return _dshCache;
  let patchText = '';
  for (const p of PATCH_PATHS) {
    try {
      patchText = await readFile(p, 'utf8');
      break;
    } catch {
      /* 下一个 */
    }
  }
  let creds = {};
  try {
    creds = parseCredRefs(await readFile(CRED_PATH, 'utf8'));
  } catch {
    /* 没凭据就走自带 key 那条路 */
  }
  const { providers, chain } = parseProviders(patchText);
  _dshCache = { providers, chain, creds, hasPatch: Boolean(patchText) };
  return _dshCache;
}

/** 组装候选渠道列表（按优先级） */
export async function resolveChannels(config = {}) {
  const custom = [];
  const dshCh = [];
  // ① 技能自己配的（给别人用）—— 优先级最高，不参与下面的排序
  const c = config.llm || {};
  if (c.apiKey && c.baseURL && c.model) {
    custom.push({
      source: 'config',
      provider: 'custom',
      model: c.model,
      api: c.api || 'openai-completions',
      baseURL: c.baseURL.replace(/\/$/, ''),
      apiKey: c.apiKey,
      maxTokens: Number(c.maxTokens || 800),
    });
  }
  // ② 复用 DSH 配置（给自己用）
  if (c.reuseDsh !== false) {
    const dsh = await loadDshLLMConfig();
    const want = c.provider ? [{ provider: c.provider, model: c.model || '' }] : dsh.chain;
    const seen = new Set();
    for (const item of want) {
      const p = dsh.providers[item.provider];
      if (!p) continue;
      const key = dsh.creds[p.apiKeyEnv];
      if (!key) continue; // 这条渠道没凭据 → 跳过（不报错，让别人接管）
      const model = item.model || p.models[0];
      if (!model || !p.baseURL) continue;
      const sig = `${item.provider}/${model}`;
      if (seen.has(sig)) continue; // 默认模型与 chain 首项常常重复，去个重
      seen.add(sig);
      dshCh.push({
        source: 'dsh',
        provider: item.provider,
        model,
        api: p.api || 'openai-completions',
        baseURL: String(p.baseURL).replace(/\/$/, ''),
        apiKey: key,
        maxTokens: Number(c.maxTokens || 800),
      });
    }
    // ⚠️ 用户 2026-11-09：「LLM 应复用（直接使用）当前 DSH 模型路由选择，不要在 skill 中写具体模型名称」
    //    → 这里**不做任何按名字的排序**：
    //      · DSH 当前默认模型已在 chain 最前面（parseProviders 里 unshift）
    //      · 其余渠道保持 DSH 配置里的原始顺序
    //    → 要换模型就在 DSH 里切，skill 自动跟随；skill 里不出现任何具体模型名。
  }
  return [...custom, ...dshCh];
}

/**
 * 中性多模态 content → 各 API 风格（2026-11-16 图片识别 S4）。
 *   string 原样返回（纯文本，完全兼容旧行为）；
 *   数组块 {type:'text',text} / {type:'image',url?,base64?,mediaType?}
 *   → openai image_url（url 或 data URI）/ anthropic image source（base64 或 url）。
 */
function toApiContent(content, api) {
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
      const url = b.url || `data:${mediaType};base64,${b.base64}`;
      return { type: 'image_url', image_url: { url } };
    }
    return { type: 'text', text: b.text || '' };
  });
}

/** 统一成一种"消息"格式后，按渠道的 api 风格发请求 */
async function callOnce(ch, { system, messages, temperature, maxTokens, timeoutMs }) {
  messages = (messages || []).map((m) => ({ role: m.role, content: toApiContent(m.content, ch.api) }));
  const ctrl = new AbortController();
  // ⚠️ anthropic 风格的渠道**强制 thinking**，思考长度波动很大，
  //    实测单次 11~60s 不等 → 给它们更宽的超时，别在 60s 就掐掉。
  const budget =
    ch.api === 'anthropic-messages' ? Math.max(timeoutMs || 0, 150000) : timeoutMs || 60000;
  const timer = setTimeout(() => ctrl.abort(), budget);
  try {
    if (ch.api === 'anthropic-messages') {
      const url = `${ch.baseURL}/v1/messages`;
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': ch.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: ch.model,
          // ⚠️ anthropic 风格渠道**强制要求 thinking**（thinking.type=disabled 会被 400 拒：
          //    "requires adaptive thinking"），思考会吃掉大半预算。
          //    给小了只会拿到一段 thinking、正文是空的（stop_reason=max_tokens）。
          max_tokens: Math.max(maxTokens, 8000),
          temperature,
          system,
          messages,
        }),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
      const j = JSON.parse(text);
      // ⚠️ anthropic 风格的 content 块**没有 type 字段**：先是 {thinking, signature}（推理过程），
      //    真正的正文是后面的 {text: "..."}。只认 type==='text' 会把答案全丢掉（返回空）。
      //    所以：取所有「带 text 字段且不是 thinking」的块拼起来。
      const blocks = Array.isArray(j.content) ? j.content : [];
      const out = blocks
        .filter((b) => b && typeof b === 'object' && typeof b.text === 'string' && b.text)
        .map((b) => b.text)
        .join('');
      return { ok: true, text: out, raw: j };
    }
    // openai-completions（含 ollama 的 /v1）
    const url = `${ch.baseURL}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ch.apiKey}` },
      body: JSON.stringify({
        model: ch.model,
        temperature,
        max_tokens: maxTokens,
        messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
      }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) };
    const j = JSON.parse(text);
    const msg = j.choices?.[0]?.message || {};
    // 有些网关把正文放在别的字段（content 为空但有 output_text / 数组形式）
    const content =
      msg.content ||
      j.choices?.[0]?.text ||
      j.output_text ||
      (Array.isArray(msg.content)
        ? msg.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('')
        : '');
    return { ok: true, text: content, raw: j };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── O1 渠道健康冷却（2026-11-18）：失败记冷却（指数退避），期内跳过，免每次白撞失败渠道 ──
// 只用运行期 sig（provider/model），不写死模型名（用户 2026-11-09 规矩不变）。
const _health = new Map();
let _healthLoaded = false;
const sigOf = (ch) => `${ch.provider}/${ch.model}`;
const healthFile = () => join(SKILL_ROOT, 'data', 'llm-health.json');

function loadHealth() {
  if (_healthLoaded) return;
  _healthLoaded = true;
  let removed = 0;
  try {
    const j = JSON.parse(readFileSync(healthFile(), 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(j || {})) {
      // 2026-11-19 审查：**顺手清理已过期记录**（否则文件只增不减，长期缓慢膨胀）
      if ((v?.cooldownUntil || 0) > now) _health.set(k, v);
      else removed++;
    }
  } catch {}
  // 清理过就落盘一次（避免每次启动都重复过滤同一批过期项）
  if (removed > 0) saveHealth();
}
function saveHealth() {
  try {
    mkdirSync(dirname(healthFile()), { recursive: true });
    writeFileSync(healthFile(), JSON.stringify(Object.fromEntries(_health)));
  } catch {}
}
/** 失败→冷却 base*2^(fails-1) 封顶 max；成功→清零。纯逻辑便于测试。 */
export function noteHealth(map, sig, ok, now, { baseCooldownMs = 120000, maxCooldownMs = 1800000 } = {}) {
  if (ok) { map.delete(sig); return map; }
  const cur = map.get(sig) || { fails: 0, cooldownUntil: 0 };
  const fails = cur.fails + 1;
  map.set(sig, { fails, failAt: now, cooldownUntil: now + Math.min(maxCooldownMs, baseCooldownMs * 2 ** (fails - 1)) });
  return map;
}
/** 冷却过滤：期内跳过；全被冷却→留最后一个做探针（绝不返回空）。 */
export function filterHealthy(channels, map, now) {
  const active = channels.filter((ch) => !((map.get(sigOf(ch))?.cooldownUntil || 0) > now));
  return active.length ? active : channels.slice(-1);
}

// ── P4-e 调用配额（2026-11-19）：每日 LLM 调用上限，超闸快速失败由调用方转人工 ──
// 与「发送闸」不同：这里管的是**成本**（judge/改写/生成都会烧 token），发送量由各通道上限管。
const usageFile = () => join(SKILL_ROOT, 'data', 'llm-usage.json');
let _usage = null;
const todayKey = () => new Date().toISOString().slice(0, 10);

function loadUsageCount() {
  if (_usage) return _usage;
  let n = 0;
  try {
    const j = JSON.parse(readFileSync(usageFile(), 'utf8'));
    if (j?.day === todayKey()) n = Number(j.calls) || 0;
  } catch {}
  _usage = { day: todayKey(), calls: n };
  return _usage;
}
function bumpUsage(persist) {
  const u = loadUsageCount();
  if (u.day !== todayKey()) { u.day = todayKey(); u.calls = 0; } // 跨天重置
  u.calls++;
  if (persist) {
    try {
      mkdirSync(dirname(usageFile()), { recursive: true });
      writeFileSync(usageFile(), JSON.stringify(u, null, 2));
    } catch {}
  }
}
/** 供日报/排障读取：{day, calls} */
export function llmUsageCount() {
  const u = loadUsageCount();
  return u.day === todayKey() ? { ...u } : { day: todayKey(), calls: 0 };
}

/**
 * 生成一段文本：按渠道顺序尝试，第一个成功的返回
 * @returns {{ok:boolean, text?:string, channel?:string, model?:string, tried?:Array, error?:string}}
 */
export async function chat(config, opts = {}) {
  const channels = await resolveChannels(config);
  return chatWithChannels(channels, opts, config);
}

/** 渠道列表注入 seam（测试用）；健康冷却+小任务偏好在此生效。 */
export async function chatWithChannels(channels, { system = '', messages = [], temperature = 0.7, maxTokens = 800, timeoutMs = 60000, log = () => {} } = {}, config = {}) {
  if (!channels.length) {
    return { ok: false, error: '没有可用的 LLM 渠道（config.llm 未配 API Key，且 DSH 里没有可用凭据）' };
  }
  // P4-e：日调用配额闸（0/未配 = 不限）
  const hcfg0 = config?.llm?.health || config?.llmHealth || {};
  const cap = Number(config?.llm?.dailyCallCap ?? 0);
  const persistUsage = config?.llm?.usagePersist !== false;
  if (cap > 0) {
    const u = loadUsageCount();
    const used = u.day === todayKey() ? u.calls : 0;
    if (used >= cap) {
      log(`      [LLM] 已达日调用上限 ${cap}（今日 ${used} 次）→ 本次不调用，调用方转人工`);
      return { ok: false, error: 'llm_daily_cap', capped: true, used, cap };
    }
  }
  const hcfg = config?.llm?.health || config?.llmHealth || {};
  const enabled = hcfg.enabled !== false;
  let list = channels;
  if (enabled) {
    const persist = hcfg.persist !== false;
    if (persist) loadHealth(); // persist=false 时只用进程内内存表（测试/临时关盘）
    const now = Date.now();
    const active = filterHealthy(list, _health, now);
    if (active.length < list.length) log(`      [LLM] 冷却跳过 ${list.length - active.length} 个渠道`);
    list = active;
  }
  // 小任务（judge/改写类 ≤40 tokens）openai 风格稳定前置：anthropic 强制 thinking 吃预算（F2）。
  // 与冷却开关解耦（独立生效）。默认开启，config.llm.health.smallTaskPreferOpenai=false 可关。
  if (maxTokens <= 40 && hcfg.smallTaskPreferOpenai !== false) {
    list = [...list.filter((c) => c.api === 'openai-completions'), ...list.filter((c) => c.api !== 'openai-completions')];
  }
  const tried = [];
  for (const ch of list) {
    bumpUsage(persistUsage); // P4-e：每发起一次真实请求就计数（含失败尝试）
    const r = await callOnce(ch, { system, messages, temperature, maxTokens: maxTokens || ch.maxTokens, timeoutMs });
    const good = r.ok && String(r.text || '').trim();
    tried.push({ provider: ch.provider, model: ch.model, ok: r.ok, status: r.status, error: r.ok ? undefined : r.error });
    if (enabled) {
      noteHealth(_health, sigOf(ch), Boolean(good), Date.now(), hcfg);
      if (hcfg.persist !== false) saveHealth();
    }
    if (good) {
      // 用户 2026-11-09：不在 skill 里写/打具体模型名 —— 只报「第几个渠道」
      log(`      [LLM] 已生成（渠道 ${tried.length}）`);
      return { ok: true, text: r.text.trim(), channel: ch.provider, model: ch.model, tried };
    }
    log(`      [LLM] 渠道 ${tried.length} 失败（${r.status || '异常'}）${r.error ? '：' + String(r.error).slice(0, 160) : ''}`);
  }
  return { ok: false, error: '所有渠道都失败', tried };
}

/** 模型是否支持视觉（图片识别 S4）。白名单优先，否则按能力词匹配（不写死具体模型名）。 */
const VISION_RE = /vl|vision|omni|multimodal/i;
export function isVisionModel(model, config = {}) {
  const wl = config?.llm?.visionModels;
  if (Array.isArray(wl) && wl.includes(model)) return true;
  return VISION_RE.test(String(model || ''));
}

/**
 * 视觉渠道解析（完全沿用 resolveChannels 的两条路）：
 *   ① config.llm.vision（apiKey/baseURL/model 三项齐全）→ 直接用 —— **给别人用**（他人自己的 VLM key）
 *   ② 否则复用 DSH 路由：providers + credentials，挑 vision-capable 模型 —— **跟随 DSH / 给自己用**
 *   ③ 都没有 → []（调用方降级，绝不瞎编）
 * 不在 skill 写死具体模型名：跟随 DSH 时按 isVisionModel 能力筛选，保持 DSH provider 顺序。
 */
export async function resolveVisionChannels(config = {}) {
  const custom = [];
  const dshCh = [];
  const v = config?.llm?.vision || {};
  if (v.apiKey && v.baseURL && v.model) {
    custom.push({
      source: 'config-vision',
      provider: 'custom-vision',
      model: v.model,
      api: v.api || 'openai-completions',
      baseURL: v.baseURL.replace(/\/$/, ''),
      apiKey: v.apiKey,
      maxTokens: Number(v.maxTokens || 1200),
    });
  }
  if (config?.llm?.reuseDsh !== false) {
    const dsh = await loadDshLLMConfig();
    const wantModel = v.model || '';
    // provider 优先级：先 DSH chain 出现顺序，再补其余 provider
    const order = [...new Set(dsh.chain.map((c) => c.provider))];
    for (const pid of Object.keys(dsh.providers)) if (!order.includes(pid)) order.push(pid);
    const seen = new Set();
    for (const pid of order) {
      const p = dsh.providers[pid];
      if (!p) continue;
      const key = dsh.creds[p.apiKeyEnv];
      if (!key || !p.baseURL) continue;
      const models = wantModel ? [wantModel] : (p.models || []).filter((m) => isVisionModel(m, config));
      for (const model of models) {
        if (!model) continue;
        if (!wantModel && !isVisionModel(model, config)) continue;
        const sig = `${pid}/${model}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        dshCh.push({
          source: 'dsh',
          provider: pid,
          model,
          api: p.api || 'openai-completions',
          baseURL: String(p.baseURL).replace(/\/$/, ''),
          apiKey: key,
          maxTokens: Number(v.maxTokens || 1200),
        });
      }
    }
  }
  return [...custom, ...dshCh];
}

/**
 * 看图生成文本：按视觉渠道顺序尝试（多模态 messages 含 image 块）。
 * 与 chat 同构，只是渠道来自 resolveVisionChannels、默认温度更低（看图要稳）。
 */
export async function chatVision(config, { system = '', messages = [], temperature = 0.3, maxTokens = 1200, timeoutMs = 90000, log = () => {} } = {}) {
  const channels = await resolveVisionChannels(config);
  if (!channels.length) {
    return { ok: false, error: '没有可用的视觉渠道（config.llm.vision 未配 API Key，且 DSH 里没有 vision-capable 模型凭据）' };
  }
  const tried = [];
  for (const ch of channels) {
    const r = await callOnce(ch, { system, messages, temperature, maxTokens: maxTokens || ch.maxTokens, timeoutMs });
    tried.push({ provider: ch.provider, model: ch.model, ok: r.ok, status: r.status, error: r.ok ? undefined : r.error });
    if (r.ok && String(r.text || '').trim()) {
      log(`      [VLM] 已生成（渠道 ${tried.length}）`);
      return { ok: true, text: r.text.trim(), channel: ch.provider, model: ch.model, tried };
    }
    log(`      [VLM] 渠道 ${tried.length} 失败（${r.status || '异常'}）${r.error ? '：' + String(r.error).slice(0, 160) : ''}`);
  }
  return { ok: false, error: '所有视觉渠道都失败', tried };
}

/** 体检用：当前能用哪些渠道（不打印密钥） */
export async function describeChannels(config = {}) {
  const channels = await resolveChannels(config);
  return channels.map((c) => ({ source: c.source, provider: c.provider, model: c.model, api: c.api, baseURL: c.baseURL }));
}
