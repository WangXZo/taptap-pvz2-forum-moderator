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
import { homedir } from 'node:os';
import { join } from 'node:path';

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
    // 按「实测快慢」排序（DSH 的默认模型会随你在 GUI 里切模型而变，不能直接照它的顺序等）：
    //   volcengine-plan 快且稳 → minimax/kimi 要长时间思考 → ollama 最后（中文不行）
    if (!c.provider) {
      const pref = ['volcengine-plan', 'deepseek-official', 'minimax', 'kimi', 'ollama'];
      dshCh.sort((a, b) => {
        const ia = pref.indexOf(a.provider);
        const ib = pref.indexOf(b.provider);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
    }
  }
  return [...custom, ...dshCh];
}

/** 统一成一种"消息"格式后，按渠道的 api 风格发请求 */
async function callOnce(ch, { system, messages, temperature, maxTokens, timeoutMs }) {
  const ctrl = new AbortController();
  // ⚠️ anthropic 风格的渠道（MiniMax/Kimi）**强制 thinking**，思考长度波动很大，
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
          // ⚠️ MiniMax-M3.1-Flash **强制要求 thinking**（thinking.type=disabled 会被 400 拒：
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
      // ⚠️ MiniMax 的 content 块**没有 type 字段**：先是 {thinking, signature}（推理过程），
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

/**
 * 生成一段文本：按渠道顺序尝试，第一个成功的返回
 * @returns {{ok:boolean, text?:string, channel?:string, model?:string, tried?:Array, error?:string}}
 */
export async function chat(config, { system = '', messages = [], temperature = 0.7, maxTokens = 800, timeoutMs = 60000, log = () => {} } = {}) {
  const channels = await resolveChannels(config);
  if (!channels.length) {
    return { ok: false, error: '没有可用的 LLM 渠道（config.llm 未配 API Key，且 DSH 里没有可用凭据）' };
  }
  const tried = [];
  for (const ch of channels) {
    const r = await callOnce(ch, { system, messages, temperature, maxTokens: maxTokens || ch.maxTokens, timeoutMs });
    tried.push({ provider: ch.provider, model: ch.model, ok: r.ok, status: r.status, error: r.ok ? undefined : r.error });
    if (r.ok && String(r.text || '').trim()) {
      log(`      [LLM] ${ch.provider}/${ch.model}`);
      return { ok: true, text: r.text.trim(), channel: ch.provider, model: ch.model, tried };
    }
    log(`      [LLM] ${ch.provider}/${ch.model} 失败（${r.status || '异常'}）${r.error ? '：' + String(r.error).slice(0, 160) : ''}`);
  }
  return { ok: false, error: '所有渠道都失败', tried };
}

/** 体检用：当前能用哪些渠道（不打印密钥） */
export async function describeChannels(config = {}) {
  const channels = await resolveChannels(config);
  return channels.map((c) => ({ source: c.source, provider: c.provider, model: c.model, api: c.api, baseURL: c.baseURL }));
}
