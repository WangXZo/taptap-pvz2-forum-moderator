// 图片识别能力包适配层（薄壳 + 本项目的业务用法）
//
// 分工（2026-11-24 设计）：
//   · 独立能力包 `image-recognition-ai-ocr` —— 通用识图：给图片和任务，返回结构化 JSON
//   · 本文件（taptap 主 skill 侧）—— 论坛业务：
//       ① 业务意图门控（求码/加好友帖不读图）
//       ② 相关性启发式（正文长且明确 → 装饰配图，不值得读）
//       ③ 把识别结果**回灌**成帖子文本（下游 QA/搜索/组答自动受益）
//       ④ 注入本项目专用的看图 prompt 与模板库
//
// 找不到能力包 → 跳过图片识别，主流程照跑（skipped='no-image-skill'）。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractImages } from './http.mjs';
import { looksLikeCodeAsk } from './code-guard.mjs';
import { detectFriendRequest } from './mod-task.mjs';
import { looksLikeQuestion } from './qa.mjs';
import { chatVision } from './llm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, '..', '..'); // scripts/lib → skill 根

/** PVZ2 专用看图提示词（能力包内置的是通用版，这里覆盖成领域版） */
const PVZ2_PROMPT = `你是《植物大战僵尸2》论坛的看图助手。仔细看这张/这些游戏截图，用简洁中文输出要点（只描述图里真实可见的内容，看不清的不要猜，不要编造）：
- 场景类型：错误弹窗 / 关卡进度 / 植物阵容 / 活动页面 / 植物图鉴 / 其他
- 植物名称（若可见）
- 活动页面：活动名称、奖励物品及数量、参与条件、剩余时间
- 植物图鉴：植物名称、属性数值、技能/说明文本摘要
- 错误弹窗：错误文案、错误码
- 玩家可能在问什么
直接输出要点文本，不要用 markdown 标题。`;

/** 找能力包入口：环境变量 → 独立安装目录 → 同父目录 → 本 skill 自带 skills/ */
export function resolveImageEntry() {
  const override = process.env.DSH_IMAGE_RECOGNITION;
  if (override === 'none') return null;
  const candidates = [
    ...(override ? [override] : []),
    resolve(homedir(), '.dsh', 'skills', 'image-recognition-ai-ocr', 'scripts', 'index.mjs'),
    resolve(homedir(), '.openclaw', 'skills', 'image-recognition-ai-ocr', 'scripts', 'index.mjs'),
    resolve(process.cwd(), '..', 'image-recognition-ai-ocr', 'scripts', 'index.mjs'),
    resolve(SKILL_ROOT, 'skills', 'image-recognition-ai-ocr', 'scripts', 'index.mjs'),
    resolve(process.cwd(), 'skills', 'image-recognition-ai-ocr', 'scripts', 'index.mjs'),
  ];
  return candidates.find((p) => p && existsSync(p)) || null;
}

let mod = null;
let loadTried = false;

export async function loadImageMod(log = () => {}) {
  if (!loadTried) {
    loadTried = true;
    const entry = resolveImageEntry();
    if (!entry) {
      log('  [图片] 没找到 image-recognition-ai-ocr 能力包 → 跳过图片识别');
      return null;
    }
    try {
      mod = await import(pathToFileURL(entry).href);
      log(`  [图片] 已加载 image-recognition-ai-ocr（${entry}）`);
    } catch (e) {
      log(`  [图片] 能力包加载失败（${e.message}）→ 跳过图片识别`);
      return null;
    }
  }
  return mod;
}

/** 仅供测试：清空模块缓存，让下次调用重新解析入口 */
export function _resetForTest() {
  mod = null;
  loadTried = false;
}

// ───────────────────────── 业务逻辑（留在主 skill） ─────────────────────────

/**
 * 业务意图门控：求码帖 / 加好友帖 → 不读图。
 * 这是论坛业务规则，不属于通用识图能力。
 */
export function isCodeIntent({ title = '', text = '' } = {}, config = {}) {
  const blob = `${title || ''}\n${text || ''}`;
  if (looksLikeCodeAsk(blob)) return { skip: true, reason: '求码帖' };
  const fr = detectFriendRequest({
    title,
    text,
    bareCodeIsIntent: config?.image?.bareCodeIsIntent ?? true,
  });
  if (fr?.hit) return { skip: true, reason: `好友意图(${fr.confidence || 'hit'})` };
  return { skip: false };
}

/**
 * 相关性启发式：正文长且明确 → 配图多半是装饰，不值得花钱读。
 * （通用「图有没有信息」由能力包的预筛负责；这里判的是**业务上值不值得**。）
 */
export function imageRelevance({ title = '', text = '', images = [] } = {}, config = {}) {
  if (!images.length) return 'none';
  const cfg = config?.image?.relevanceGate || {};
  const body = `${title || ''} ${text || ''}`.replace(/\s+/g, ' ').trim();
  const len = body.length;
  const shortText = Number(cfg.shortTextLen ?? 30);
  const longText = Number(cfg.longTextLen ?? 120);
  const unknownAsRelevant = cfg.unknownAsRelevant !== false;
  if (looksLikeQuestion(body)) return 'relevant';
  if (len <= shortText) return 'relevant';
  if (len >= longText) return 'decorative';
  return unknownAsRelevant ? 'relevant' : 'unknown';
}

// ───────────────────────── 模板库（PVZ2 专用，留在主 skill） ─────────────────────────

/** 读 PVZ2 特征模板库 → 能力包要的 templates 格式 */
export function loadTemplates(config = {}) {
  const raw = config?.image?.features?.dir;
  const dir = raw
    ? resolve(String(raw).replace(/\{\{SKILL\}\}/g, SKILL_ROOT))
    : resolve(SKILL_ROOT, 'assets', 'game-features');
  let defs = [];
  try {
    defs = JSON.parse(readFileSync(resolve(dir, 'features.json'), 'utf8')).features || [];
  } catch {
    return { dir, templates: [], defs: [] };
  }
  const templates = [];
  for (const d of defs) {
    if (d.method !== 'template' || !d.template) continue;
    const p = resolve(dir, d.template);
    if (!existsSync(p)) continue;
    try {
      templates.push({
        id: d.id,
        name: d.name,
        image: readFileSync(p).toString('base64'),
        threshold: Number(d.threshold ?? 0.85),
      });
    } catch {
      /* 单张模板读失败跳过 */
    }
  }
  return { dir, templates, defs };
}

/** 特征 id → 是否触发「庆祝」意图 */
function celebrateIds(defs) {
  const s = new Set();
  for (const d of defs || []) if (d.trigger === 'celebrate') s.add(d.id);
  return s;
}

// ───────────────────────── 主入口：识别 + 回灌 ─────────────────────────

/**
 * 帖级图片增强（本项目业务封装）：取图 → 业务门控 → 调能力包 → 回灌文本
 *
 * 这是**调用方的用法**，不是能力包的接口 —— 能力包只提供通用的 recognize()。
 *
 * @returns {Promise<{text, imageText, images, relevance, skipped, sources, celebrate, entities}>}
 */
export async function enrichPostImages(
  item,
  { config = {}, log = () => {}, title = '', text = '', cache = null, recognize = null } = {}
) {
  const ic = config?.image || {};
  const images = extractImages(item);
  const base = {
    images,
    imageText: '',
    relevance: 'none',
    skipped: '',
    sources: [],
    celebrate: false,
    entities: [],
  };

  if (ic.enabled === false) return { ...base, text, skipped: 'disabled' };
  if (!images.length) return { ...base, text, skipped: 'no-image' };

  // ① 业务意图门控（求码/加好友 → 不读图）
  const intent = isCodeIntent({ title, text }, config);
  if (intent.skip) return { ...base, text, skipped: `code-intent:${intent.reason}` };

  // ② 业务相关性（装饰配图不值得读）
  const relevance = imageRelevance({ title, text, images }, config);
  if (relevance === 'decorative') return { ...base, text, relevance, skipped: 'decorative' };
  if (relevance === 'unknown') return { ...base, text, relevance, skipped: 'unknown' };

  // ③ 调能力包
  let rec = recognize;
  if (!rec) {
    const m = await loadImageMod(log);
    if (!m?.recognize) return { ...base, text, relevance, skipped: 'no-image-skill' };
    rec = m.recognize;
  }

  const useFeatures = ic.features?.enabled !== false;
  const { templates, defs } = useFeatures ? loadTemplates(config) : { templates: [], defs: [] };
  const taskList = useFeatures ? ['text', 'feature'] : ['text'];

  let r;
  try {
    r = await rec({
      tasks: taskList,
      images: [item],
      extractor: extractImages,
      hint: '读出图里的文字，并指出可见的植物/奖励/界面元素',
      context: '植物大战僵尸2 论坛玩家发的截图',
      prompt: PVZ2_PROMPT,
      templates: templates.length ? templates : undefined,
      options: {
        ocr: { enabled: ic.ocr?.enabled !== false, server: ic.ocr?.server, timeoutMs: ic.ocr?.timeoutMs },
        features: { enabled: useFeatures, server: ic.features?.server, timeoutMs: ic.features?.timeoutMs },
        vision: { enabled: ic.vision?.enabled !== false, chatVision, temperature: ic.vision?.temperature, maxTokens: ic.vision?.maxTokens, timeoutMs: ic.vision?.timeoutMs },
        prefilter: {
          quality: ic.prefilter?.quality !== false,
          vlmBinary: ic.prefilter?.vlmBinary !== false,
        },
        cache,
        log,
      },
    });
  } catch (e) {
    log(`  [图片] 识别异常：${e.message} → 跳过`);
    return { ...base, text, relevance, skipped: `error:${e.message}` };
  }

  if (!r?.ok) {
    return { ...base, text, relevance, skipped: `error:${r?.error || 'unknown'}` };
  }

  // ④ 汇总：文字 + 特征 + 庆祝标记
  //    能力包单任务时 results 是数组（配 r.task），组合任务时是按任务分组的对象 —— 两种都吃
  const byTask =
    r.results && typeof r.results === 'object' && !Array.isArray(r.results)
      ? r.results
      : { [r.task || 'text']: Array.isArray(r.results) ? r.results : [] };
  const textRes = (byTask.text || []).filter((x) => x.text);
  const featRes = (byTask.feature || []).filter((x) => x.features?.length || x.description);
  const parts = [];
  const sources = [];

  for (const t of textRes) {
    parts.push(t.text);
    if (!sources.includes(t.method) && t.method !== 'none') sources.push(t.method);
  }
  const celIds = celebrateIds(defs);
  let celebrate = false;
  const entities = [];
  for (const f of featRes) {
    if (f.features?.length) {
      const names = f.features.map((x) => x.name).filter(Boolean);
      if (names.length) parts.push(`图中识别到：${names.join('、')}`);
      for (const x of f.features) {
        if (x.name) entities.push(x.name);
        if (x.id && celIds.has(x.id)) celebrate = true;
      }
      if (!sources.includes('template')) sources.push('template');
    }
    if (f.description) {
      parts.push(f.description);
      if (!sources.includes('vlm')) sources.push('vlm');
    }
  }

  const imageText = parts.join('\n').trim();
  if (!imageText) {
    const why = (r.meta?.degraded || []).slice(0, 2).join(',') || 'empty';
    return { ...base, text, relevance, skipped: `empty-recognition(${why})`, sources };
  }

  // ⑤ 回灌（识别内容并入帖子文本，下游自动受益）
  const merged = `${text || ''}\n[图片内容] ${imageText}`.trim();
  return {
    text: merged,
    imageText,
    images,
    relevance: 'relevant',
    skipped: '',
    sources,
    celebrate,
    entities: [...new Set(entities)],
  };
}

/** OCR/模板服务是否在线（体检用） */
export async function imageServiceHealth(config = {}) {
  const m = await loadImageMod();
  if (!m?.ocrHealth) return { ok: false, reason: 'no-image-skill' };
  return m.ocrHealth({ server: config?.image?.ocr?.server });
}

/** 空缓存（能力包未装时不识别，也就不需要缓存） */
function nullCache() {
  return {
    get() {
      return undefined;
    },
    set() {},
    save() {},
    get size() {
      return 0;
    },
  };
}

/**
 * 取识别结果缓存（能力包未装 → 空缓存）
 * 缓存在能力包里实现（按图 hash + 任务签名 + TTL），这里只是转手。
 */
export async function getImageCache(file, opts = {}) {
  const m = await loadImageMod();
  if (m?.loadCache) return m.loadCache(file, opts);
  return nullCache();
}

export { PVZ2_PROMPT };