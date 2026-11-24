// 资料层：本 skill 可以有自己的资料，不只用调用方给的。
//
// 三层资料，按优先级从低到高合并：
//   ① 内置资料（builtin）  随包分发，assets/materials/ 下的 .md / .json
//                          —— 通用领域知识：场景分类法、标签词表、常见图片类型
//   ② 调用方资料（caller） 本次调用传入 options.materials
//                          —— 具体项目背景：这是什么游戏、术语表、示例
//   ③ 积累资料（learned）  运行中沉淀到 data/materials.json
//                          —— 人工确认过的新标签/新特征说明，下次自动带上
//
// 三者揉成「资料块」注入 prompt，让模型判断更准。
// **业务专属资料（如某个游戏的植物图鉴）不放内置层** —— 那是调用方的事，
// 内置层只放「放到任何识图场景都成立」的通用知识。

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(HERE, '..'); // scripts/ → 能力包根
const BUILTIN_DIR = resolve(PKG_ROOT, 'assets', 'materials');

/** 单个资料项标准化 */
function normalizeItem(raw, source) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const content = raw.trim();
    return content ? { id: null, title: '', content, source, tags: [] } : null;
  }
  if (typeof raw !== 'object') return null;
  const content = String(raw.content ?? raw.text ?? '').trim();
  if (!content) return null;
  return {
    id: raw.id ? String(raw.id) : null,
    title: String(raw.title ?? raw.name ?? ''),
    content,
    source,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
  };
}

/** 读内置资料目录 */
function readBuiltin(dir = BUILTIN_DIR) {
  const out = [];
  if (!existsSync(dir)) return out;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const p = resolve(dir, e.name);
    const ext = extname(e.name).toLowerCase();
    const id = basename(e.name, ext);
    try {
      if (ext === '.json') {
        const j = JSON.parse(readFileSync(p, 'utf8'));
        const arr = Array.isArray(j) ? j : Array.isArray(j.materials) ? j.materials : [j];
        for (const it of arr) {
          const n = normalizeItem(it, 'builtin');
          if (n) out.push({ ...n, id: n.id || id });
        }
      } else if (ext === '.md' || ext === '.txt') {
        const content = readFileSync(p, 'utf8').trim();
        if (content) {
          // 首个 # 标题当 title
          const m = content.match(/^#\s+(.+)$/m);
          out.push({ id, title: m ? m[1].trim() : id, content, source: 'builtin', tags: [] });
        }
      }
    } catch {
      /* 单个资料读失败跳过，不影响其它 */
    }
  }
  return out;
}

/** 读积累资料（运行中沉淀的） */
function readLearned(file) {
  if (!file || !existsSync(file)) return [];
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const arr = Array.isArray(j) ? j : Array.isArray(j.materials) ? j.materials : [];
    return arr.map((it) => normalizeItem(it, 'learned')).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 加载并合并三层资料
 *
 * @param {object} o
 * @param {Array|object} [o.extra]  调用方资料：数组 或 {title: content} 对象
 * @param {string} [o.learnedFile]  积累资料文件（data/materials.json）
 * @param {string} [o.builtinDir]   覆盖内置目录（测试用）
 * @param {boolean} [o.builtin=true] 是否带内置资料
 * @param {string[]} [o.onlyTags]   只保留带这些标签的资料
 * @returns {Array<{id,title,content,source,tags}>}
 */
export function loadMaterials({
  extra = null,
  learnedFile = null,
  builtinDir,
  builtin = true,
  onlyTags = null,
} = {}) {
  const builtinList = builtin ? readBuiltin(builtinDir) : [];

  let callerList = [];
  if (Array.isArray(extra)) {
    callerList = extra.map((x) => normalizeItem(x, 'caller')).filter(Boolean);
  } else if (extra && typeof extra === 'object') {
    callerList = Object.entries(extra)
      .map(([title, content]) => normalizeItem({ title, content }, 'caller'))
      .filter(Boolean);
  }

  const learnedList = readLearned(learnedFile);

  // 合并：同 id 后者覆盖前者（调用方 > 内置；积累 > 调用方）
  const byId = new Map();
  const noId = [];
  for (const list of [builtinList, callerList, learnedList]) {
    for (const it of list) {
      if (it.id) byId.set(it.id, it);
      else noId.push(it);
    }
  }
  let merged = [...byId.values(), ...noId];

  if (Array.isArray(onlyTags) && onlyTags.length) {
    merged = merged.filter((m) => m.tags.some((t) => onlyTags.includes(t)));
  }
  return merged;
}

/** 把资料揉成注入 prompt 的文本块（带长度上限，防止把 prompt 撑爆） */
export function formatMaterials(materials, { maxChars = 4000 } = {}) {
  const list = (materials || []).filter((m) => m && m.content);
  if (!list.length) return '';
  const parts = [];
  let used = 0;
  for (const m of list) {
    const head = m.title ? `### ${m.title}\n` : '';
    const block = `${head}${m.content}`;
    if (used + block.length > maxChars) {
      const room = maxChars - used;
      if (room > 80) parts.push(block.slice(0, room) + '…');
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n\n');
}

/**
 * 沉淀一条资料（opt-in，调用方明确要才写）
 * 用于把人工确认过的新标签/新特征说明攒下来，下次自动带上。
 * @returns {boolean} 是否写入成功
 */
export function learnMaterial(file, item) {
  if (!file) return false;
  const n = normalizeItem(item, 'learned');
  if (!n || !n.content) return false;
  try {
    const arr = readLearned(file);
    const idx = n.id ? arr.findIndex((x) => x.id === n.id) : -1;
    if (idx >= 0) arr[idx] = n;
    else arr.push(n);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ materials: arr }, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}