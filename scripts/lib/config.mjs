// 统一配置解析（2026-11-20 · 阶段 3）
//
// 大哥要求：「配置放统一配置文件管理。并添加说明。（可人为开关，不要依赖代码才能进行配置处理）」
//
// 所以要解决三件事：
//   ① **一个开关只在一个地方**：以前同一个功能有 `features.x` / `plugins.x` / 顶层 `x.enabled` 三套，
//      且 `loadPlugins` 里 `plugins` 覆盖 `features` —— 读配置的人必然误判。
//   ② **行为参数可配**：以前 reply.apiIntervalMs=1000、maxChars=70/130、limit=30、contextMaxChars=3000
//      全写死在代码里，改一次要动 JS 还要重测。
//   ③ **自描述**：schema.json 是唯一权威（类型/默认/范围/说明），文档由它生成，永不脱节。
//
// 设计约束（都是为了不破坏现状）：
//   · **只补不改**：schema 默认值只填「配置里没有的键」，绝不覆盖用户显式写的值。
//   · **迁移是双写**：旧键 → 新键，**旧键保留**（loadPlugins 等老代码还在读它）。
//     等所有消费方改造完成后再删旧键。迁移清单必须打印，不静默。
//   · **校验不阻断**：类型/范围不对只返回 issues 并打日志，不 throw —— 守护不能因为一个配置项写错就停。
//   · **env 覆盖**：`TAPTAP_CFG_<GROUP>_<FIELD>`，给 CI/临时实验用，正式值仍写 config.json。

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SCHEMA_FILE = resolve(HERE, '..', 'config', 'schema.json');

/**
 * 旧键 → 新键（值语义相同）
 * 只做映射，不删旧键（老消费方还在读）
 */
export const LEGACY_MAP = {
  'features.image': 'image.enabled',
  'features.weekly': 'weekly.enabled',
  'features.ingest': 'ingest.enabled',
  'features.review': 'review.enabled',
  'features.mod': 'modTasks.enabled',
  // ⚠️ comment 两处都有（features.comment / plugins.comment）：
  //    旧 loadPlugins 里 `plugins` 覆盖 `features`，所以**只认 plugins.comment**。
  //    两个都映射到同一目标会触发「新旧冲突」，反而写不进正确值。
  'plugins.comment': 'comment.enabled',
  'plugins.praise': 'praise.enabled',
  'plugins.share': 'share.enabled',
  'plugins.comfort': 'comfort.enabled',
  'plugins.interact': 'interact.enabled',
  // ⚠️ 目标是 codeMatch（大写 M），与 config.json 的实际键名一致
  'plugins.codematch': 'codeMatch.enabled',
};

/** 点路径读 */
export function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * 深合并（b 覆盖 a）——给 config.local.json 用
 * 只合并普通对象；数组/标量直接替换（数组不做逐项合并，避免语义歧义）
 */
export function deepMerge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = a && typeof a === 'object' && !Array.isArray(a) ? { ...a } : {};
  for (const [k, v] of Object.entries(b)) {
    if (k.startsWith('__')) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 点路径写（中间层自动建对象）
 *
 * 保护：如果中间层**已经是标量**（例如 `appId` 是 54031，却要写 `appId.appId`），
 * 不覆盖它，直接放弃这次写入并返回被阻塞的位置。
 * 历史教训：早期版本会无条件 `cur[k] = {}`，把 appId 从 54031 改成了 `{appId:54031}`。
 */
export function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const existing = cur[k];
    if (existing === undefined || existing === null) {
      cur[k] = {};
    } else if (typeof existing !== 'object' || Array.isArray(existing)) {
      return { ok: false, blockedBy: keys.slice(0, i + 1).join('.') };
    }
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return { ok: true };
}

/** 读 schema 文件 */
export function loadSchema(file = DEFAULT_SCHEMA_FILE) {
  if (!existsSync(file)) return { groups: {} };
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * 把 schema 摊平成 [{path, def, group}]
 *
 * `root` 是特殊分组：字段直接落在 config 顶层（不带分组前缀）。
 * 为什么需要：appId / groupId / pipeline 这些是顶层标量，若按分组处理会变成 `appId.appId`，
 * 而 applyDefaults 遇到「父级已是标量」时会把它覆盖成对象 —— 曾把 appId 从 54031 改成 {appId:54031}。
 */
export function listFields(schema) {
  const out = [];
  for (const [gid, g] of Object.entries(schema?.groups || {})) {
    for (const [k, def] of Object.entries(g.fields || {})) {
      const path = gid === 'root' ? k : `${gid}.${k}`;
      out.push({ path, def, group: gid, groupLabel: g.label || gid });
    }
  }
  return out;
}

/** 类型检查 */
function typeOk(value, type) {
  if (value === null || value === undefined) return false;
  switch (type) {
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && !Array.isArray(value);
    case 'any': return true;
    default: return true;
  }
}

/**
 * 校验（不阻断）
 * @returns {Array<{path, level:'error'|'warn', message, value}>}
 */
export function validateConfig(config, schema) {
  const issues = [];
  for (const { path, def } of listFields(schema)) {
    const v = getPath(config, path);
    if (v === undefined) {
      if (def.required) issues.push({ path, level: 'error', message: '缺少必填项', value: v });
      continue;
    }
    if (def.type && !typeOk(v, def.type)) {
      issues.push({ path, level: 'error', message: `类型应为 ${def.type}，实际 ${Array.isArray(v) ? 'array' : typeof v}`, value: v });
      continue;
    }
    if (def.enum && !def.enum.includes(v)) {
      issues.push({ path, level: 'error', message: `取值必须是 ${def.enum.join('/')}，实际 ${JSON.stringify(v)}`, value: v });
    }
    if (def.type === 'integer' || def.type === 'number') {
      if (def.min !== undefined && v < def.min) issues.push({ path, level: 'error', message: `不得小于 ${def.min}`, value: v });
      if (def.max !== undefined && v > def.max) issues.push({ path, level: 'error', message: `不得大于 ${def.max}`, value: v });
    }
  }
  return issues;
}

/**
 * 旧键搬家（双写：写新键，保留旧键）
 * @returns {{config, moved: Array<{from,to,value}>, conflicts: Array}}
 */
export function migrateLegacy(config) {
  const moved = [];
  const conflicts = [];
  for (const [from, to] of Object.entries(LEGACY_MAP)) {
    const oldVal = getPath(config, from);
    if (oldVal === undefined) continue;
    const newVal = getPath(config, to);
    if (newVal !== undefined && newVal !== oldVal) {
      // 两边都写了且不一致 → 不擅自决定，报冲突（新键优先）
      conflicts.push({ from, to, oldValue: oldVal, newValue: newVal, winner: 'new' });
      continue;
    }
    if (newVal === undefined) {
      setPath(config, to, oldVal);
      moved.push({ from, to, value: oldVal });
    }
  }
  return { config, moved, conflicts };
}

/** 环境变量覆盖：TAPTAP_CFG_<GROUP>_<FIELD>（组/字段里的大写，点换下划线） */
export function applyEnv(config, schema, env = process.env) {
  const applied = [];
  for (const { path, def } of listFields(schema)) {
    const key = `TAPTAP_CFG_${path.replace(/\./g, '_').toUpperCase()}`;
    if (!(key in env)) continue;
    const raw = env[key];
    let v = raw;
    if (def.type === 'boolean') v = /^(1|true|yes|on)$/i.test(raw);
    else if (def.type === 'integer') v = Number.parseInt(raw, 10);
    else if (def.type === 'number') v = Number(raw);
    else if (def.type === 'array') { try { v = JSON.parse(raw); } catch { continue; } }
    if (def.type && !typeOk(v, def.type)) continue;
    setPath(config, path, v);
    applied.push({ path, key, value: v });
  }
  return { config, applied };
}

/** 按 schema 补默认值（**只补缺失，绝不覆盖已写**） */
export function applyDefaults(config, schema) {
  const filled = [];
  const blocked = [];
  for (const { path, def } of listFields(schema)) {
    if (def.default === undefined) continue;
    if (getPath(config, path) !== undefined) continue;
    const r = setPath(config, path, JSON.parse(JSON.stringify(def.default)));
    if (r.ok) filled.push({ path, value: def.default });
    else blocked.push({ path, blockedBy: r.blockedBy });
  }
  return { config, filled, blocked };
}

/**
 * 主入口：迁移 → 补默认 → env 覆盖 → 校验
 * @param {object} raw           原始 config.json
 * @param {object} [o]
 * @param {object} [o.schema]    schema（不给就读 schema.json）
 * @param {Function} [o.log]
 * @param {object} [o.env]
 * @param {boolean} [o.quiet]
 */
export function resolveConfig(raw = {}, { schema = null, log = null, env = process.env, quiet = false } = {}) {
  const sch = schema || loadSchema();
  const cfg = raw;

  const mig = migrateLegacy(cfg);
  const def = applyDefaults(cfg, sch);
  const en = applyEnv(cfg, sch, env);
  const issues = validateConfig(cfg, sch);

  // 迁移/覆盖一律打印，绝不静默（历史上「配置没生效但没人知道」踩过坑）
  // 但只打**汇总**：迁移是内存双写，每次启动都会发生，逐项打印会把守护日志刷掉
  if (log && !quiet) {
    if (mig.moved.length) {
      log(
        `  [配置] 旧键已迁移 ${mig.moved.length} 项（保留旧键兼容；新键优先）：` +
          mig.moved.map((m) => `${m.from}→${m.to}`).join(', ')
      );
    }
    if (mig.conflicts.length) {
      log(`  [配置] ⚠ 新旧键冲突 ${mig.conflicts.length} 项（以新键为准）：${mig.conflicts.map((c) => `${c.from}≠${c.to}`).join(', ')}`);
    }
    if (en.applied.length) {
      log(`  [配置] 环境变量覆盖 ${en.applied.length} 项：${en.applied.map((a) => a.path).join(', ')}`);
    }
    const errs = issues.filter((i) => i.level === 'error');
    if (errs.length) {
      log(`  [配置] ⚠ 校验发现 ${errs.length} 处问题（不阻断运行）：`);
      for (const e of errs.slice(0, 12)) log(`    ${e.path}: ${e.message}`);
    }
  }

  cfg.__configMeta = {
    migrated: mig.moved,
    conflicts: mig.conflicts,
    envApplied: en.applied,
    defaultsFilled: def.filled.length,
    issues,
  };
  return cfg;
}

/**
 * 把当前 config 与 schema 对比，列出「配置里写了但 schema 没定义」的键
 * 用于发现遗漏（新加参数忘了写 schema）
 */
export function diffExtraKeys(config, schema) {
  const known = new Set(listFields(schema).map((f) => f.path));
  // 分组名前缀（root 不算：它的字段就在顶层）
  const groups = new Set(Object.keys(schema?.groups || {}).filter((g) => g !== 'root'));
  // 旧键是**有意保留**的（双写兼容，等消费方改造完才删），不算「漏写 schema」
  // features.comment 单独列出：它被 plugins.comment 覆盖，不进 LEGACY_MAP 但仍属已知旧键
  const legacyKeys = new Set([...Object.keys(LEGACY_MAP), 'features.comment']);
  const extras = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (k.startsWith('__')) continue;
      // note / xxxNote 是给人看的说明字段，不是配置项
      if (k === 'note' || /Note$/.test(k)) continue;
      const p = prefix ? `${prefix}.${k}` : k;
      if (legacyKeys.has(p)) continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        // 不在 schema 分组里、且没有直接命中字段 → 继续下钻
        if (!groups.has(p) && !known.has(p)) walk(v, p);
        if (!groups.has(p) && !known.has(p) && Object.keys(v).length === 0) extras.push(p);
      } else if (!known.has(p)) {
        extras.push(p);
      }
    }
  };
  walk(config, '');
  return extras.filter((p) => !p.includes('__config'));
}