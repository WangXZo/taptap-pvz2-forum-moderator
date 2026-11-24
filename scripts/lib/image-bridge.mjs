// 图片识别能力包适配层（薄壳）
//
// 为什么是「薄壳」而不是把代码抄一遍：
//   图片识别（取图 → 意图/相关性门控 → OCR/VLM/模板 → 回灌文本）已单独抽成能力包
//   `pvz2-image-recognition`，定位与 `baidu-websearch` 一样 —— 通用能力、可独立安装、
//   别的项目也能直接用。这里只负责「找到它、调用它、失败就静默降级」——
//   taptap skill 里不复制实现，避免两份代码各自漂移。
//
// 找不到能力包（比如别人只拷了 taptap 这一个 skill）→ **跳过图片识别**，主流程照跑。
//
// 【依赖注入】判定逻辑**不复制**：求码判定（code-guard）、提问判定（qa）、
//   加好友判定（mod-task）、看图渠道（llm 的多模态）都由本薄壳从 taptap skill
//   自己的模块注入给能力包 —— 单一事实源，能力包改了不会跟主 skill 漂移。
//   能力包独立使用时没有注入，走它自己的保守兜底（宁可多识别，不误判跳过）。
//
// 调用约定：
//   enrichPostImages(item, opts) → {text, imageText, images, relevance, skipped, sources, celebrate, entities}
//     text = 回灌后的帖子文本（下游 QA 匹配 / 联网搜索 / LLM 组答自动受益）
//     skipped 非空 = 没识别（带原因，如 'no-image-skill' / 'decorative' / 'code-intent:求码帖'）

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractImages } from './http.mjs';
import { looksLikeCodeAsk } from './code-guard.mjs';
import { detectFriendRequest } from './mod-task.mjs';
import { looksLikeQuestion } from './qa.mjs';
import { chatVision, resolveVisionChannels } from './llm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, '..', '..'); // scripts/lib → taptap skill 根

/** 找图片识别能力包的入口文件：先 DSH skills 目录，再同级的兄弟目录，最后仓库内自带那份 */
export function resolveImageEntry() {
  // 显式覆盖（多项目共用 / 测试用）：
  //   指向具体文件路径 → 用这个
  //   设为 'none'      → 明确禁用（本项目不做图片识别）
  const override = process.env.DSH_PVZ2_IMAGE;
  if (override === 'none') return null;
  const candidates = [
    ...(override ? [override] : []),
    // ① 独立安装（~/.dsh/skills/ 或 ~/.openclaw/skills/）
    resolve(homedir(), '.dsh', 'skills', 'pvz2-image-recognition', 'scripts', 'image.mjs'),
    resolve(homedir(), '.openclaw', 'skills', 'pvz2-image-recognition', 'scripts', 'image.mjs'),
    // ② skill 目录同级（有人把两个 skill 放在同一父目录下）
    resolve(process.cwd(), '..', 'pvz2-image-recognition', 'scripts', 'image.mjs'),
    // ③ 仓库内自带的那份（taptap skill 的 skills/ 子目录，分发形态）
    resolve(SKILL_ROOT, 'skills', 'pvz2-image-recognition', 'scripts', 'image.mjs'),
    resolve(process.cwd(), 'skills', 'pvz2-image-recognition', 'scripts', 'image.mjs'),
  ];
  return candidates.find((p) => p && existsSync(p)) || null;
}

let mod = null;
let loadTried = false;

/** 加载能力包（只试一次） */
export async function loadImageMod(log = () => {}) {
  if (!loadTried) {
    loadTried = true;
    const entry = resolveImageEntry();
    if (!entry) {
      log('  [图片] 没找到 pvz2-image-recognition 能力包 → 跳过图片识别');
      return null;
    }
    try {
      mod = await import(pathToFileURL(entry).href);
      log(`  [图片] 已加载 pvz2-image-recognition（${entry}）`);
    } catch (e) {
      log(`  [图片] 加载失败（${e.message}）→ 跳过图片识别`);
      return null;
    }
  }
  return mod;
}

/** 仅供测试：清空模块缓存，让下一次调用重新解析入口（配合 DSH_PVZ2_IMAGE） */
export function _resetForTest() {
  mod = null;
  loadTried = false;
}

/** 能力包缺失时的空缓存（不识别，也就不需要缓存） */
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
 * 拿识别结果缓存（能力包未装 → 空缓存）
 * @returns {Promise<{get:Function,set:Function,save:Function,size:number}>}
 */
export async function getImageCache(file, opts = {}) {
  const m = await loadImageMod();
  if (m?.loadImageCache) return m.loadImageCache(file, opts);
  return nullCache();
}

/** OCR 服务是否在线（体检用；能力包未装 → 报未装） */
export async function ocrHealth(config = {}) {
  const m = await loadImageMod();
  if (!m?.ocrHealth) return { ok: false, reason: 'no-image-skill' };
  return m.ocrHealth(config);
}

/**
 * 图片识别主入口（薄壳）
 *
 * @param item feed list item（含 moment.topic.footer_images）
 * @param opts {config, log, title, text, recognize?, cache?}
 * @returns {Promise<{text:string, imageText:string, images:Array, relevance:string,
 *   skipped:string, sources:Array, celebrate:boolean, entities:Array}>}
 */
export async function enrichPostImages(item, opts = {}) {
  const { log = () => {}, text = '' } = opts;
  const m = await loadImageMod(log);
  if (!m?.enrichPostImages) {
    // 能力包不在 → 跳过图片识别，主流程照跑（text 原样返回）
    return {
      images: extractImages(item),
      imageText: '',
      relevance: 'none',
      skipped: 'no-image-skill',
      sources: [],
      celebrate: false,
      entities: [],
      text,
    };
  }
  return m.enrichPostImages(item, {
    ...opts,
    deps: {
      extractImages,
      looksLikeCodeAsk,
      detectFriendRequest,
      looksLikeQuestion,
      chatVision,
      resolveVisionChannels,
    },
  });
}
