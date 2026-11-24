// 缩图：把大图缩成适合发给 VLM 的尺寸（走本地服务的 /resize）
//
// 为什么需要（2026-11-24 实测）：
//   VLM 请求体是整张图的 base64。一张 820KB 的帖子截图 → base64 约 1.1MB。
//   多模态调用本身 15s 左右，但一旦某条渠道失败/超时、换下一条就**重传这 1.1MB** ——
//   实测单张图能烧 100~160 秒。
//   本地缩到长边 1024 后通常只剩几十 KB，上传与推理都明显变快。
//
// 缩图走本地服务（要求服务已启动）；服务不在 → **原样返回**，不阻断识别。

import { cacheKey } from './cache.mjs';

const DEFAULT_SERVER = 'http://127.0.0.1:8791';

/**
 * 缩一张图
 * @param {{ref:string, base64:string, format?:string, bytes?:number}} img
 * @param {object} o
 * @param {string} [o.server]   本地服务地址
 * @param {number} [o.maxSide]  长边上限（默认 1024）
 * @param {object} [o.cache]    {get,set}
 * @param {Function} [o.log]
 * @returns {Promise<{image:object, shrunk:boolean, reason?:string}>}
 */
export async function shrinkImage(img, { server = DEFAULT_SERVER, maxSide = 1024, cache = null, log = () => {}, timeoutMs = 15000 } = {}) {
  if (!img?.base64) return { image: img, shrunk: false, reason: 'no-base64' };
  const key = cacheKey('shrink', img.base64.slice(0, 2048) + img.base64.length, String(maxSide));
  const hit = cache?.get?.(key);
  if (hit?.image) {
    return { image: { ...img, base64: hit.image, format: 'jpg', bytes: hit.bytes }, shrunk: true, reason: 'cached' };
  }
  try {
    const r = await fetch(String(server).replace(/\/$/, '') + '/resize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: img.base64, maxSide }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j?.ok || !j.image) throw new Error(j?.error || 'no image');
    cache?.set?.(key, { image: j.image, bytes: j.bytes });
    return {
      image: { ...img, base64: j.image, format: 'jpg', bytes: j.bytes, width: j.width, height: j.height },
      shrunk: true,
    };
  } catch (e) {
    // 缩图失败不是错误 —— 用原图继续，只是慢一点
    log(`  [缩图] ${img.ref || ''} 跳过（${e.message}）→ 用原图`);
    return { image: img, shrunk: false, reason: e.message };
  }
}

/**
 * 批量缩图
 * @returns {Promise<{images:Array, shrunk:number}>}
 */
export async function shrinkImages(images, opt = {}) {
  const out = [];
  let shrunk = 0;
  for (const img of images || []) {
    const r = await shrinkImage(img, opt);
    if (r.shrunk) shrunk += 1;
    out.push(r.image);
  }
  return { images: out, shrunk };
}