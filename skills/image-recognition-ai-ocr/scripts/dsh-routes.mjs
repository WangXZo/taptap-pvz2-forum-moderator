// 读 DSH 的模型路由配置（复用宿主环境，不在本 skill 里写死任何模型名）
//
// 两个文件：
//   ~/.dsh/profiles/{web,default}/cordis.patch.yml  → providers（baseURL / api 风格 / 模型清单）+ chain 顺序
//   ~/.dsh/.credentials.yaml                        → refs 里的 API Key 引用
//
// 为什么本 skill 自己读而不是 import 调用方的实现：
//   这是**宿主环境**（DSH）的约定，不是某个业务项目的私有逻辑 —— 谁都能读，
//   所以本 skill 自带一份；业务侧（如 taptap 版主 skill）另有自己那份，两者互不依赖。
//
// ⚠️ 凭据只在内存里用，不落盘、不打印、不进日志。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DSH_DIR = join(homedir(), '.dsh');
const PATCH_PATHS = [
  join(DSH_DIR, 'profiles', 'web', 'cordis.patch.yml'),
  join(DSH_DIR, 'profiles', 'default', 'cordis.patch.yml'),
];
const CRED_PATH = join(DSH_DIR, '.credentials.yaml');

/** 极简 YAML 读取：只取 `refs:` 段下的 `KEY: value`（够用，不引依赖） */
export function parseCredRefs(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  let inRefs = false;
  for (const line of lines) {
    if (/^refs\s*:/.test(line)) {
      inRefs = true;
      continue;
    }
    if (!inRefs) continue;
    if (/^\S/.test(line) && !/^\s*#/.test(line)) break; // refs 段结束
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

/**
 * 从 patch.yml 抠 providers 与 chain（行解析，够用即可）
 *
 * 每个模型按对象解析，**保留它声明的输入能力** —— 这是判断"能不能看图"的权威依据，
 * 别靠模型名去猜（用户实测：DSH 里大部分 LLM 都声明了 image 输入）。
 *
 * 真实结构（缩进照抄 ~/.dsh/profiles/web/cordis.patch.yml）：
 * ```
 *     providers:
 *       kimi:
 *         apiKeyEnv: KIMI_API_KEY
 *         api: anthropic-messages
 *         baseURL: https://api.moonshot.cn/anthropic
 *         models:
 *           - id: kimi-k3
 *             name: Kimi K3
 *             contextWindow: 1048576
 *             input:
 *               - text
 *               - image
 * ```
 */
export function parseProviders(text) {
  const providers = {};
  const chain = [];
  const lines = String(text || '').split(/\r?\n/);

  let cur = null; // 当前 provider id
  let curModel = null; // 当前模型对象
  let inProviders = false;
  let inInput = false; // 是否在某个模型的 input: 列表里

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s{4}providers:\s*$/.test(line)) {
      inProviders = true;
      continue;
    }
    if (inProviders && /^\s{4}\S/.test(line) && !/^\s{4}providers:/.test(line)) {
      inProviders = false;
      cur = null;
      curModel = null;
      inInput = false;
    }
    if (!inProviders) continue;

    // provider 名（6 空格）
    const pm = line.match(/^\s{6}([A-Za-z0-9_\-]+):\s*$/);
    if (pm) {
      cur = pm[1];
      curModel = null;
      inInput = false;
      providers[cur] = { id: cur, apiKeyEnv: '', api: '', baseURL: '', models: [] };
      continue;
    }
    if (!cur) continue;

    // provider 级字段（8 空格）
    const kv = line.match(/^\s{8}(apiKeyEnv|api|baseURL|displayName):\s*(.+?)\s*$/);
    if (kv) {
      providers[cur][kv[1]] = kv[2].replace(/^["']|["']$/g, '');
      continue;
    }

    // 模型起点（10 空格 `- id: xxx`）
    const mm = line.match(/^\s{10}-?\s*id:\s*(.+?)\s*$/);
    if (mm) {
      curModel = { id: mm[1].replace(/^["']|["']$/g, ''), input: [] };
      providers[cur].models.push(curModel);
      inInput = false;
      continue;
    }

    if (!curModel) continue;

    // 模型级字段（12 空格）
    const mk = line.match(/^\s{12}([A-Za-z0-9_]+):\s*(.*?)\s*$/);
    if (mk) {
      const key = mk[1];
      const val = mk[2].replace(/^["']|["']$/g, '');
      inInput = key === 'input' && val === '';
      if (!inInput) curModel[key] = val;
      continue;
    }

    // input 列表项（14 空格 `- text` / `- image`）
    if (inInput) {
      const li = line.match(/^\s{14}-?\s*([A-Za-z0-9_]+)\s*$/);
      if (li) {
        curModel.input.push(li[1].toLowerCase());
        continue;
      }
      if (/\S/.test(line)) inInput = false; // 离开 input 段
    }
  }

  // chain：llm-failover 下的 `- provider: X`（10 空格）+ 下一行 `model: Y`（12 空格）
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

  // 当前默认模型：找 `id: agent-default-model` 那段往下几行
  let def = null;
  const di = lines.findIndex((l) => /^\s*-?\s*id:\s*agent-default-model\s*$/.test(l));
  if (di >= 0) {
    for (let i = di + 1; i < Math.min(di + 8, lines.length); i++) {
      const p = lines[i].match(/^\s*provider:\s*(\S+)/);
      const m = lines[i].match(/^\s*model:\s*(\S+)/);
      if (p && !def) def = { provider: p[1], model: '' };
      if (m && def && !def.model) def.model = m[1];
      if (def?.provider && def?.model) break;
    }
  }
  if (def?.provider) chain.unshift(def); // 默认模型排最前

  return { providers, chain };
}

/** 取某 provider 的模型 id 列表（兼容对象/字符串两种形态） */
export function modelIds(provider) {
  return (provider?.models || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
}

let _cache = null;

/**
 * 读 DSH 配置（进程内缓存一次）
 * @param {{refresh?:boolean, patchPaths?:string[], credPath?:string}} [opt]
 * @returns {Promise<{providers:object, chain:Array, creds:object, hasPatch:boolean}>}
 */
export async function loadDshRoutes({ refresh = false, patchPaths = PATCH_PATHS, credPath = CRED_PATH } = {}) {
  if (_cache && !refresh) return _cache;
  let patchText = '';
  for (const p of patchPaths) {
    try {
      patchText = await readFile(p, 'utf8');
      break;
    } catch {
      /* 试下一个 */
    }
  }
  let creds = {};
  try {
    creds = parseCredRefs(await readFile(credPath, 'utf8'));
  } catch {
    /* 没凭据文件就走"自备 KEY"那条路 */
  }
  const { providers, chain } = parseProviders(patchText);
  _cache = { providers, chain, creds, hasPatch: Boolean(patchText) };
  return _cache;
}

/** 仅供测试：清缓存 */
export function _resetDshCache() {
  _cache = null;
}

export { DSH_DIR, PATCH_PATHS, CRED_PATH };