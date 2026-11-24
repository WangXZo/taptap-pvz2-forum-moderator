// image-recognition-ai-ocr · 统一入口
//
// 定位：为 AI 识图准备的**通用能力**。图片、任务、资料都由使用者提供，
// 本 skill 按任务类型产出结构化 JSON；**业务判断归下游**。
//
// 三类任务：
//   match    判断：图片是否匹配某意图 → 置信度
//   text     读字：图片 → 文字 + 标签
//   feature  认特征：图片 → 特征 + 描述
//
// 一次可跑多个任务（task: ['text','feature']），共享取图/下载/缓存。
//
// 零领域耦合：取图（extractor）、看图渠道（chatVision）、任务说明（hint）、
// 模板库（templates）、业务资料（materials/context）全部由调用方提供或可覆盖；
// 本包自带通用资料（assets/materials/）与可选的内置看图渠道（环境变量）。

import { normalizeImages, fingerprint, genericExtractor } from './image.mjs';
import { prefilter } from './prefilter.mjs';
import { loadMaterials } from './materials.mjs';
import { loadCache, memoryCache } from './cache.mjs';
import { resolveVision, describeImages } from './vision.mjs';
import { ocrHealth, ocrImages } from './ocr.mjs';
import { runMatch } from './tasks/match.mjs';
import { runText } from './tasks/text.mjs';
import { runFeature } from './tasks/feature.mjs';

/** 支持的任务类型 */
export const TASKS = ['match', 'text', 'feature'];

/** 归一化任务参数：task / tasks 都接受，去重保序，校验合法性 */
export function normalizeTasks({ task, tasks } = {}) {
  const list = Array.isArray(tasks) ? tasks : tasks ? [tasks] : Array.isArray(task) ? task : task ? [task] : [];
  const out = [];
  for (const t of list) {
    const k = String(t || '').trim().toLowerCase();
    if (!k) continue;
    if (!TASKS.includes(k)) return { error: `未知任务类型：${t}（支持 ${TASKS.join(' / ')}）` };
    if (!out.includes(k)) out.push(k);
  }
  if (!out.length) return { error: `缺少 task（支持 ${TASKS.join(' / ')}）` };
  return { tasks: out };
}

/**
 * 识图主入口
 *
 * @param {object} input
 * @param {'match'|'text'|'feature'|Array} [input.task] 任务（单一）
 * @param {Array} [input.tasks] 任务（多个，与 task 等价）
 * @param {Array} input.images 图片：URL / base64 / dataURI / 对象
 * @param {Function} [input.extractor] 取图函数（对象 → URL 数组）
 * @param {Array} [input.intents] T1：意图 [{id,label,description}]
 * @param {boolean} [input.onlyBest] T1：只返最高分
 * @param {string} [input.hint] T2/T3：任务说明
 * @param {Array} [input.templates] T3：模板库 [{id,name,image(base64),threshold}]
 * @param {string} [input.context] 背景资料（调用方）
 * @param {Array|object} [input.materials] 补充资料（调用方，覆盖内置）
 * @param {string} [input.prompt] 覆盖任务提示词（少用）
 * @param {object} [input.options] 通道与运行参数
 * @returns {Promise<object>}
 */
export async function recognize(input = {}) {
  const t0 = Date.now();
  const opt = input.options || {};

  const nt = normalizeTasks({ task: input.task, tasks: input.tasks });
  if (nt.error) {
    return { ok: false, error: nt.error, results: [], meta: { ms: Date.now() - t0 } };
  }
  const taskList = nt.tasks;

  if (!input.images || (Array.isArray(input.images) && !input.images.length)) {
    return { ok: false, error: '缺少 images', results: [], meta: { tasks: taskList, ms: Date.now() - t0 } };
  }

  const log = typeof opt.log === 'function' ? opt.log : () => {};
  const maxImages = Number(opt.maxImages ?? 20);
  const cache = opt.cache !== undefined ? opt.cache : opt.cacheFile ? loadCache(opt.cacheFile, { ttlHours: opt.cacheTtlHours ?? 168 }) : memoryCache();

  // ① 取图
  const rawImages = await normalizeImages(input.images, {
    extractor: input.extractor || null,
    log,
    timeoutMs: Number(opt.downloadTimeoutMs ?? 30000),
  });
  const images = rawImages.slice(0, Math.max(0, maxImages));
  const truncated = rawImages.length > images.length ? rawImages.length - images.length : 0;
  if (truncated) log(`  [识图] 图片超过上限 ${maxImages} 张，已截断 ${truncated} 张`);

  // ② 资料（内置 + 调用方 + 积累）
  const materials = loadMaterials({
    extra: input.materials ?? null,
    learnedFile: opt.learnedMaterialsFile || null,
    builtin: opt.builtinMaterials !== false,
  });

  // ③ 预筛（质量 + VLM 二分类）
  const pf = opt.prefilter || {};
  const pfResult = await prefilter(images, {
    quality: pf.quality !== false,
    vlmBinary: pf.vlmBinary !== false,
    config: opt.vision || {},
    materials,
    log,
  });
  const usable = pfResult.kept;

  // ④ 逐任务执行
  const degraded = [];
  const methods = new Set();
  const perTask = {};

  for (const t of taskList) {
    if (!usable.length) {
      perTask[t] = [];
      continue;
    }
    if (t === 'match') {
      const r = await runMatch(usable, {
        intents: input.intents || [],
        onlyBest: Boolean(input.onlyBest),
        hint: input.hint || '',
        context: input.context || '',
        materials,
        config: opt.vision || {},
        cache,
        log,
      });
      perTask[t] = r.results;
      r.degraded.forEach((d) => degraded.push(d));
      r.methods.forEach((m) => methods.add(m));
    } else if (t === 'text') {
      const r = await runText(usable, {
        hint: input.hint || '',
        context: input.context || '',
        materials,
        ocr: opt.ocr || {},
        vision: opt.vision || {},
        visionFallback: opt.visionFallback !== false,
        visionEnabled: (opt.vision || {}).enabled !== false,
        cache,
        log,
      });
      perTask[t] = r.results;
      r.degraded.forEach((d) => degraded.push(d));
      r.methods.forEach((m) => methods.add(m));
    } else if (t === 'feature') {
      const r = await runFeature(usable, {
        hint: input.hint || '',
        templates: input.templates || [],
        context: input.context || '',
        materials,
        features: opt.features || {},
        vision: opt.vision || {},
        visionEnabled: (opt.vision || {}).enabled !== false,
        cache,
        log,
      });
      perTask[t] = r.results;
      r.degraded.forEach((d) => degraded.push(d));
      r.methods.forEach((m) => methods.add(m));
    }
  }

  // ⑤ 组装输出
  const meta = {
    images: images.map((i) => ({
      ref: i.ref,
      url: i.url || '',
      format: i.format || '',
      bytes: i.bytes || 0,
      ...(i.error ? { error: i.error } : {}),
    })),
    tasks: taskList,
    methods: [...methods],
    degraded: [...new Set(degraded)],
    skipped: pfResult.skipped,
    materials: materials.length,
    ...(truncated ? { truncated } : {}),
    ms: Date.now() - t0,
  };

  // 落盘（调用方既给了 cacheFile、又自己传了 cache=null 时，不能假设 cache 一定有 save）
  if (opt.cacheFile && typeof cache?.save === 'function') cache.save();

  if (taskList.length === 1) {
    return { ok: true, task: taskList[0], results: perTask[taskList[0]] || [], meta };
  }
  return { ok: true, tasks: taskList, results: perTask, meta };
}

// ── 便捷再导出（下游只认一个入口文件即可） ──
export { normalizeImages, fingerprint, genericExtractor } from './image.mjs';
export { loadCache, memoryCache, cacheKey } from './cache.mjs';
export { loadMaterials, formatMaterials, learnMaterial } from './materials.mjs';
export {
  resolveVision,
  resolveVisionChannels,
  resolveOwnKey,
  resolveDshVisionChannels,
  isVisionModel,
  describeImages,
  toApiContent,
  callOnce,
} from './vision.mjs';
export { loadDshRoutes, parseProviders, parseCredRefs, _resetDshCache } from './dsh-routes.mjs';
export { ocrHealth, ocrImages, ocrImage } from './ocr.mjs';
export { matchImages, matchImage } from './features.mjs';
export { prefilter, qualityPrefilter, vlmBinaryPrefilter, parseBinaryAnswer } from './prefilter.mjs';
export { tryParseJson, toConfidence } from './json.mjs';
export { deriveLabels } from './tasks/text.mjs';
export { buildMatchPrompt, normalizeMatchResult } from './tasks/match.mjs';
export { buildFeaturePrompt } from './tasks/feature.mjs';