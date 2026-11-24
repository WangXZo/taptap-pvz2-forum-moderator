// 图片处理流水线（S1–S5）—— 独立能力包 `pvz2-image-recognition`
//
// 定位（2026-11-24 拆分）：这套识别能力从 taptap 版主 skill 里**整体拆出来**，
// 定位与 `baidu-websearch` 一样 —— 通用能力、可独立安装、别的项目也能直接用。
// 主 skill 侧只留一个薄壳（`lib/image-bridge.mjs`）负责「找到它、调用它、失败降级」。
//
// 三条规则（设计稿：任务目录 output/PVZ2图片识别-技术设计稿-20261116.md）：
//   ① 好友码/天宫码意图 → 直接跳过图片识别（走原流程，不读图）。
//   ② 其他帖先判图片相关性：无关配图跳过、相关图才识别（纯启发式起步）。
//   ③ 识别内容并入帖子内容 → 进网络搜索 + LLM 上下文（回灌 post.text）。
//
// 【依赖注入】为什么是注入而不是各自 import：
//   判定逻辑（求码 / 提问 / 加好友 / 看图渠道）在主 skill 里已经有一套**精确实现**，
//   在这里复制一份必然漂移 —— 主 skill 改了求码判定，这份不知道，跟着判错。
//   所以：主 skill 的薄壳把判定函数**注入**进来，本文件只用注入的版本；
//   没人注入时走**保守兜底**（宁可多识别，不误判为求码帖），并在日志里说明降级。
//
// 纯函数为主，识别器 recognize 可注入 → 便于离线回归（不打网络/不起 Python）。

// 顺带 re-export 各子模块，调用方只需认识**一个**入口文件
export { loadImageCache } from './image-cache.mjs';
export { ocrHealth, ocrImages } from './ocr.mjs';
export { loadFeatures, matchFeatures } from './features.mjs';
export { describeImages } from './vision.mjs';

/**
 * 内置兜底：取帖子配图
 * （与 taptap skill 的 lib/http.mjs extractImages 同规则，实测见 evidence/06：
 *   图在 moment.topic.footer_images[]，feed 层即带；CDN 无防盗链）
 */
function fallbackExtractImages(item) {
  const t = item?.moment?.topic || {};
  const arr = Array.isArray(t.footer_images) ? t.footer_images : [];
  return arr
    .filter((im) => im && (im.original_url || im.url))
    .map((im) => ({
      url: im.original_url || im.url,
      mediumUrl: im.medium_url || '',
      smallUrl: im.small_url || '',
      width: Number(im.width || 0),
      height: Number(im.height || 0),
      format: im.original_format || '',
      size: Number(im.original_size || 0),
    }));
}

/** 内置兜底判定：无注入时一律「不像」，宁可多识别也不误判跳过 */
const fallbackLooksLikeCodeAsk = () => false;
const fallbackDetectFriendRequest = () => ({ hit: false, confidence: 'none' });
const fallbackLooksLikeQuestion = () => false;

/**
 * 取判定函数（注入优先，兜底其次）
 * @param {object} deps 注入的依赖
 */
function resolveDeps(deps = {}) {
  return {
    extractImages: typeof deps.extractImages === 'function' ? deps.extractImages : fallbackExtractImages,
    looksLikeCodeAsk:
      typeof deps.looksLikeCodeAsk === 'function' ? deps.looksLikeCodeAsk : fallbackLooksLikeCodeAsk,
    detectFriendRequest:
      typeof deps.detectFriendRequest === 'function' ? deps.detectFriendRequest : fallbackDetectFriendRequest,
    looksLikeQuestion:
      typeof deps.looksLikeQuestion === 'function' ? deps.looksLikeQuestion : fallbackLooksLikeQuestion,
    chatVision: typeof deps.chatVision === 'function' ? deps.chatVision : null,
    resolveVisionChannels:
      typeof deps.resolveVisionChannels === 'function' ? deps.resolveVisionChannels : null,
  };
}

/**
 * 规则1：码/好友意图 → 跳过图片识别。
 * 判定函数由主 skill 注入（求码 + 加好友）。
 * @returns {{skip:boolean, reason?:string}}
 */
export function isCodeIntent({ title = '', text = '' } = {}, config = {}, deps = {}) {
  const d = resolveDeps(deps);
  const blob = `${title || ''}\n${text || ''}`;
  if (d.looksLikeCodeAsk(blob)) return { skip: true, reason: '求码帖' };
  const fr = d.detectFriendRequest({
    title,
    text,
    bareCodeIsIntent: config?.image?.bareCodeIsIntent ?? true,
  });
  if (fr?.hit) return { skip: true, reason: `好友意图(${fr.confidence || 'hit'})` };
  return { skip: false };
}

/**
 * 规则2：相关性门控（纯启发式起步，VLM 二分类按需后开）。
 * @returns {'none'|'relevant'|'decorative'|'unknown'}
 *   none      无图
 *   relevant  相关图（求助意图 / 正文短信息可能在图里）→ 识别
 *   decorative 无关配图（正文已长且明确）→ 跳过
 *   unknown   判不明 → 起步按相关处理（宁可多识别不漏信息，可配）
 */
export function imageRelevance({ title = '', text = '', images = [] } = {}, config = {}, deps = {}) {
  if (!images.length) return 'none';
  const d = resolveDeps(deps);
  const cfg = config?.image?.relevanceGate || {};
  const body = `${title || ''} ${text || ''}`.replace(/\s+/g, ' ').trim();
  const len = body.length;
  const shortText = Number(cfg.shortTextLen ?? 30);
  const longText = Number(cfg.longTextLen ?? 120);
  const unknownAsRelevant = cfg.unknownAsRelevant !== false;
  if (d.looksLikeQuestion(body)) return 'relevant';
  if (len <= shortText) return 'relevant';
  if (len >= longText) return 'decorative';
  return unknownAsRelevant ? 'relevant' : 'unknown';
}

/**
 * 默认识别器：S6 模板匹配（本地免费）→ S3 OCR（文字）→ S4 VLM（语义）。
 * 各模块惰性 import + 失败降级（缺依赖/无渠道不抛错，返回已拿到的部分）。
 * 识别器契约：async (images, {config,log,title,text,cache,deps}) → {text, sources:[...]}
 */
export async function defaultRecognize(images, { config = {}, log = () => {}, cache = null, deps = {} } = {}) {
  const parts = [];
  const sources = [];
  let celebrate = false;
  const entities = []; // C8：模板命中的实体名（→ facts 直连路由）
  const ic = config?.image || {};

  // S6 模板匹配（本地特征库，优先免费快）；trigger=celebrate 的特征（如瓷砖萝卜）→ 标记庆祝
  if (ic.features?.enabled) {
    try {
      const { matchFeatures } = await import('./features.mjs');
      const r = await matchFeatures(images, { config, log });
      if (r?.text) {
        parts.push(r.text);
        sources.push('template');
      }
      if (r?.celebrate) celebrate = true;
      if (Array.isArray(r?.features)) entities.push(...r.features);
    } catch (e) {
      log(`  [图片] 模板匹配跳过：${e.message}`);
    }
  }

  // S3 OCR（文字/数字/说明文本）
  if (ic.ocr?.enabled !== false) {
    try {
      const { ocrImages } = await import('./ocr.mjs');
      const r = await ocrImages(images, { config, log, cache });
      if (r?.text) {
        parts.push(r.text);
        sources.push('ocr');
      }
    } catch (e) {
      log(`  [图片] OCR 跳过：${e.message}`);
    }
  }

  // S4 VLM（游戏画面/开放语义）—— 渠道由主 skill 注入（llm.mjs）
  if (ic.vision?.enabled !== false) {
    try {
      const { describeImages } = await import('./vision.mjs');
      const r = await describeImages(images, { config, log, cache, deps });
      if (r?.text) {
        parts.push(r.text);
        sources.push('vlm');
      }
    } catch (e) {
      log(`  [图片] VLM 跳过：${e.message}`);
    }
  }

  return { text: parts.join('\n').trim(), sources, celebrate, entities: [...new Set(entities)] };
}

/**
 * 主流水线：取图 → 意图门控 → 相关性门控 → 识别 → 回灌文本。
 * @param item feed list item（含 moment.topic.footer_images）
 * @param opts {config, log, title, text, recognize?, cache?, deps?}
 * @returns {{text:string, imageText:string, images:Array, relevance:string, skipped:string, sources:Array}}
 *   text = 回灌后的帖子文本（baseText + 图片内容）；skipped 非空表示未识别（含原因）。
 */
export async function enrichPostImages(
  item,
  { config = {}, log = () => {}, title = '', text = '', recognize = null, cache = null, deps = {} } = {}
) {
  const d = resolveDeps(deps);
  const images = d.extractImages(item);
  const base = {
    images,
    imageText: '',
    relevance: 'none',
    skipped: '',
    sources: [],
    celebrate: false,
    entities: [],
  };
  if (config?.image?.enabled === false) return { ...base, text, skipped: 'disabled' };
  if (!images.length) return { ...base, text, skipped: 'no-image' };

  // 规则1：码/好友意图跳过
  const intent = isCodeIntent({ title, text }, config, deps);
  if (intent.skip) return { ...base, text, skipped: `code-intent:${intent.reason}` };

  // 规则2：相关性门控
  const relevance = imageRelevance({ title, text, images }, config, deps);
  if (relevance === 'decorative') return { ...base, text, relevance, skipped: 'decorative' };
  if (relevance === 'unknown') return { ...base, text, relevance, skipped: 'unknown' };

  // 识别（可注入）
  const rec = recognize || defaultRecognize;
  let result;
  try {
    result = await rec(images, { config, log, title, text, cache, deps });
  } catch (e) {
    log(`  [图片] 识别异常：${e.message} → 跳过`);
    return { ...base, text, relevance, skipped: `error:${e.message}` };
  }
  const imageText = String(result?.text || '').trim();
  const sources = result?.sources || [];
  const entities = Array.isArray(result?.entities) ? result.entities : [];
  if (!imageText) return { ...base, text, relevance, skipped: 'empty-recognition', sources, entities };

  // 规则3：回灌（识别内容并入帖子文本，下游 QA/搜索/组答自动受益）
  const merged = `${text || ''}\n[图片内容] ${imageText}`.trim();
  return {
    ...base,
    text: merged,
    imageText,
    images,
    relevance: 'relevant',
    skipped: '',
    sources,
    celebrate: Boolean(result?.celebrate),
    entities,
  };
}
