// image-recognition-ai-ocr · 统一入口
//
// 定位：为 AI 识图准备的**通用能力**。图片、任务、资料都由使用者提供，
// 本 skill 按任务类型产出结构化 JSON；**业务判断归下游**。
//
// 三类任务：
//   match    判断：图片是否匹配某意图 → 置信度（只为判断，不读字、不描述）
//   text     读字：图片 → 全量文字 + 标签（不限字数）
//   feature  认特征：图片 → 特征 + 描述（描述可限长，默认 200 字）
//
// 一次可跑多个任务（task: ['text','feature']），共享取图/下载/缓存。
//
// **不传 task 就是 auto**（2026-11-25 大哥定）：外部经常判断不出"这是截图还是画面"，
// 所以默认交给本 skill 按图片内容自己分流 —— 先 OCR（免费），文字够就是文字图（出 text），
// 文字不够就是画面图（出 feature 描述）；外部给了 intents 再补一次判断。
//
// 零领域耦合：取图（extractor）、任务说明（hint）、模板库（templates）、
// 业务资料（materials/context）全部由调用方提供或可覆盖；
// 本包自带通用资料（assets/materials/）与可选的内置看图渠道（环境变量）。

import { normalizeImages } from './image.mjs';
import { prefilter } from './prefilter.mjs';
import { loadMaterials } from './materials.mjs';
import { loadCache, memoryCache } from './cache.mjs';
import { runMatch } from './tasks/match.mjs';
import { runText } from './tasks/text.mjs';
import { runFeature, DEFAULT_MAX_DESC_CHARS } from './tasks/feature.mjs';

/** 支持的任务类型 */
export const TASKS = ['match', 'text', 'feature'];

/** 任务名：auto（不显式指定时由本 skill 自己判断） */
export const AUTO = 'auto';

/** auto 模式下"算文字图"的字数门槛：达到这个字数就不再让 VLM 描述 */
export const AUTO_RICH_CHARS = 20;

/**
 * 归一化任务参数：task / tasks 都接受，去重保序，校验合法性。
 * **完全没给**（或显式给 'auto'）→ auto 模式，由本 skill 判断任务类型。
 */
export function normalizeTasks({ task, tasks } = {}) {
  const list = Array.isArray(tasks) ? tasks : tasks ? [tasks] : Array.isArray(task) ? task : task ? [task] : [];
  const out = [];
  for (const t of list) {
    const k = String(t || '').trim().toLowerCase();
    if (!k) continue;
    if (k === AUTO) continue; // auto 由"没指定任务"表达
    if (!TASKS.includes(k)) return { error: `未知任务类型：${t}（支持 ${TASKS.join(' / ')}，或留空走 auto）` };
    if (!out.includes(k)) out.push(k);
  }
  return out.length ? { tasks: out, auto: false } : { tasks: [], auto: true };
}

// ── 结果行：**一图一条**（2026-11-25 大哥定） ──
// 为什么改掉 byTask 分组：auto 下每张图跑的任务可能不同（有的读字、有的描述），
// 按任务分组本身就不成立；一图一条让下游"第 n 张图有什么，就看第 n 条"。

function newRow(img) {
  return {
    image: img.ref,
    url: img.url || '',
    tasks: [],          // 这张图真正产出了内容的任务
    text: '',
    chars: 0,
    lines: [],
    labels: [],
    method: 'none',
    matches: null,      // match 才有：按置信度降序
    features: [],       // feature 才有
    description: '',    // feature 才有
  };
}

/** 合并 method 字符串（'ocr' + 'vlm' → 'ocr+vlm'） */
function mergeMethod(a, b) {
  const parts = new Set([...(a || 'none').split('+'), ...(b || 'none').split('+')].filter((x) => x && x !== 'none'));
  return parts.size ? [...parts].join('+') : 'none';
}

function mergeText(rows, results) {
  for (const r of results || []) {
    const row = rows.get(r.image);
    if (!row) continue;
    row.text = String(r.text || '');
    row.chars = row.text.length;
    row.lines = r.lines || [];
    row.labels = r.labels || [];
    row.method = mergeMethod(row.method, r.method);
    if (row.text && !row.tasks.includes('text')) row.tasks.push('text');
  }
}

function mergeFeature(rows, results) {
  for (const r of results || []) {
    const row = rows.get(r.image);
    if (!row) continue;
    row.features = r.features || [];
    row.description = String(r.description || '');
    row.method = mergeMethod(row.method, r.method);
    if ((row.features.length || row.description) && !row.tasks.includes('feature')) row.tasks.push('feature');
  }
}

function mergeMatch(rows, results) {
  const byImage = new Map();
  for (const m of results || []) {
    if (!byImage.has(m.image)) byImage.set(m.image, []);
    byImage.get(m.image).push({
      intent: m.intent,
      label: m.label,
      confidence: m.confidence,
      reason: m.reason,
      ...(m.missing ? { missing: true } : {}),
    });
  }
  for (const [ref, list] of byImage) {
    const row = rows.get(ref);
    if (!row) continue;
    row.matches = list;
    if (!row.tasks.includes('match')) row.tasks.push('match');
  }
}

/**
 * 识图主入口
 *
 * @param {object} input
 * @param {'match'|'text'|'feature'|Array|'auto'} [input.task] 任务（省略 = auto）
 * @param {Array} [input.tasks] 任务（多个，与 task 等价）
 * @param {Array} input.images 图片：URL / base64 / dataURI / 对象
 * @param {Function} [input.extractor] 取图函数（对象 → URL 数组）
 * @param {Array} [input.intents] match：意图 [{id,label,description}]
 * @param {boolean} [input.onlyBest] match：只返最高分
 * @param {string} [input.hint] text/feature：任务说明
 * @param {Array} [input.templates] feature：模板库 [{id,name,image(base64),threshold}]
 * @param {number} [input.maxDescChars] feature：描述字数上限（默认 200；0 = 不限）
 * @param {string} [input.context] 背景资料（调用方）
 * @param {Array|object} [input.materials] 补充资料（调用方，覆盖内置）
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
  const autopilot = nt.auto;
  const taskList = nt.tasks;
  // text 要先于 feature 跑：feature 会参考 text 的结果决定"这张图还要不要 VLM 描述"
  if (taskList.includes('text') && taskList.includes('feature')) {
    taskList.sort((a, b) => (a === 'text' ? -1 : b === 'text' ? 1 : 0));
  }

  if (!input.images || (Array.isArray(input.images) && !input.images.length)) {
    return { ok: false, error: '缺少 images', results: [], meta: { mode: autopilot ? AUTO : 'explicit', ms: Date.now() - t0 } };
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

  // ③ 预筛
  //    VLM 二分类（"图里有没有信息"）与"每图时间最短"冲突：
  //    auto 已经用 OCR 文字量做了分流，纯 match 本身就是在判断 —— 这两种都不跑二分类，
  //    省下每图一次模型往返。显式要 text/feature 时仍按配置跑。
  const pf = opt.prefilter || {};
  const onlyMatch = taskList.length === 1 && taskList[0] === 'match';
  const vlmBinary = pf.vlmBinary !== false && !autopilot && !onlyMatch;
  if (pf.vlmBinary !== false && !vlmBinary) {
    log(`  [识图] ${autopilot ? 'auto' : '纯判断'}模式 → 跳过 VLM 二分类预筛（省一次模型调用）`);
  }
  const pfResult = await prefilter(images, {
    quality: pf.quality !== false,
    vlmBinary,
    config: opt.vision || {},
    materials,
    log,
  });
  const usable = pfResult.kept;

  // ③½ 行表：一图一条（被预筛挡下的也留一条，下游能对上号）
  const rows = new Map();
  for (const img of images) rows.set(img.ref, newRow(img));
  for (const s of pfResult.skipped) {
    const row = rows.get(s.ref);
    if (row) row.skipped = s.reason;
  }

  // ④ 逐图/逐任务执行
  const degraded = [];
  const methods = new Set();
  const take = (r) => {
    (r?.degraded || []).forEach((d) => degraded.push(d));
    (r?.methods || []).forEach((m) => methods.add(m));
  };

  const featureOpt = {
    hint: input.hint || '',
    templates: input.templates || [],
    context: input.context || '',
    materials,
    features: opt.features || {},
    vision: opt.vision || {},
    visionEnabled: (opt.vision || {}).enabled !== false,
    // 描述输出长度：入参优先，其次 options，最后默认 200 字；0 = 不限
    maxDescChars: input.maxDescChars ?? opt.maxDescChars ?? DEFAULT_MAX_DESC_CHARS,
    cache,
    log,
  };

  if (usable.length && autopilot) {
    // ── auto：先 OCR 分流，再按类型跑 ──
    const richMin = Math.max(1, Number(opt.richTextChars ?? AUTO_RICH_CHARS));
    const t = await runText(usable, {
      ocr: opt.ocr || {},
      vision: opt.vision || {},
      // auto 不让 VLM 兜底读字：读不出字的图基本是画面类，交给 feature 更有价值
      visionFallback: false,
      visionEnabled: (opt.vision || {}).enabled !== false,
      cache,
      log,
    });
    take(t);
    mergeText(rows, t.results);

    const visual = usable.filter((img) => {
      const row = rows.get(img.ref);
      return !row || row.chars < richMin;
    });
    if (visual.length) {
      log(`  [识图] ${visual.length} 张图文字不足 ${richMin} 字 → 按画面类做特征描述`);
      const f = await runFeature(visual, { ...featureOpt, skipVisionFor: null });
      take(f);
      mergeFeature(rows, f.results);
    }

    if (Array.isArray(input.intents) && input.intents.length) {
      const m = await runMatch(usable, {
        intents: input.intents,
        onlyBest: Boolean(input.onlyBest),
        hint: input.hint || '',
        config: opt.vision || {},
        cache,
        log,
      });
      take(m);
      mergeMatch(rows, m.results);
    }
  } else if (usable.length) {
    // ── 显式任务：按调用方指定的跑（内部仍按文字量做联动判断） ──
    for (const t of taskList) {
      if (t === 'match') {
        const r = await runMatch(usable, {
          intents: input.intents || [],
          onlyBest: Boolean(input.onlyBest),
          hint: input.hint || '',
          config: opt.vision || {},
          cache,
          log,
        });
        take(r);
        mergeMatch(rows, r.results);
      } else if (t === 'text') {
        const r = await runText(usable, {
          ocr: opt.ocr || {},
          vision: opt.vision || {},
          visionFallback: opt.visionFallback !== false,
          visionEnabled: (opt.vision || {}).enabled !== false,
          cache,
          log,
        });
        take(r);
        mergeText(rows, r.results);
      } else if (t === 'feature') {
        // 文字已经读够的图就不再让 VLM 描述（省几十秒）；要强制描述传 featureVisionForRichText
        let skipVisionFor = null;
        if (taskList.includes('text') && opt.featureVisionForRichText !== true) {
          const richMin = Math.max(1, Number(opt.richTextChars ?? AUTO_RICH_CHARS));
          skipVisionFor = new Set(
            [...rows.values()].filter((row) => row.chars >= richMin).map((row) => row.image)
          );
          if (skipVisionFor.size) log(`  [识图] ${skipVisionFor.size} 张图文字已读够 → 跳过 VLM 语义描述`);
        }
        const r = await runFeature(usable, { ...featureOpt, skipVisionFor });
        take(r);
        mergeFeature(rows, r.results);
      }
    }
  }

  // ⑤ 组装输出
  const resultRows = images.map((img) => rows.get(img.ref)).filter(Boolean);
  const ranTasks = [...new Set(resultRows.flatMap((r) => r.tasks))];
  const meta = {
    mode: autopilot ? AUTO : 'explicit',
    images: images.map((i) => ({
      ref: i.ref,
      url: i.url || '',
      format: i.format || '',
      bytes: i.bytes || 0,
      ...(i.error ? { error: i.error } : {}),
    })),
    tasks: autopilot ? ranTasks : taskList,
    methods: [...methods],
    degraded: [...new Set(degraded)],
    skipped: pfResult.skipped,
    materials: materials.length,
    ...(truncated ? { truncated } : {}),
    ms: Date.now() - t0,
  };

  // 落盘（调用方既给了 cacheFile、又自己传了 cache=null 时，不能假设 cache 一定有 save）
  if (opt.cacheFile && typeof cache?.save === 'function') cache.save();

  const out = { ok: true, mode: meta.mode, results: resultRows, meta };
  // 兼容旧调用方：显式单任务仍带 task，显式多任务仍带 tasks（结果形状已统一为一图一条）
  if (!autopilot) {
    if (taskList.length === 1) out.task = taskList[0];
    else out.tasks = taskList;
  }
  return out;
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
  supportsImageInput,
  describeImages,
  toApiContent,
  callOnce,
  orderChannels,
  noteChannel,
  channelLatency,
  _resetChannelMemory,
} from './vision.mjs';
export { shrinkImage, shrinkImages } from './shrink.mjs';
export { loadDshRoutes, parseProviders, parseCredRefs, _resetDshCache } from './dsh-routes.mjs';
export { ocrHealth, ocrImages, ocrImage } from './ocr.mjs';
export { matchImages, matchImage } from './features.mjs';
export { prefilter, qualityPrefilter, vlmBinaryPrefilter, parseBinaryAnswer } from './prefilter.mjs';
export { tryParseJson, toConfidence, salvageJsonObjects } from './json.mjs';
export { deriveLabels } from './tasks/text.mjs';
export { buildMatchPrompt, normalizeMatchResult, matchMaxTokens } from './tasks/match.mjs';
export { buildFeaturePrompt, DEFAULT_MAX_DESC_CHARS, tokensForChars } from './tasks/feature.mjs';