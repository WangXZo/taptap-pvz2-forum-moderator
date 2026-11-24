// 取图与图片规范化
//
// 输入三种形态，统一成内部结构：
//   ① URL 字符串          → 下载 → base64
//   ② base64 / data URI   → 直接用
//   ③ 调用方对象          → 交给注入的 extractor 解析出 URL
//
// 为什么要 extractor：不同来源的图片挂在不同字段上（TapTap 在
// moment.topic.footer_images[]，网页在 og:image / img[src]……）。
// 本 skill 只内置**通用**抽取，平台特有的由调用方注入，避免耦合。

import { createHash } from 'node:crypto';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** 图片最小的合理体积（再小基本是占位图/坏图） */
const MIN_BYTES = 100;

/** 从 data URI 里拆出 base64 与格式 */
function parseDataUri(s) {
  const m = String(s).match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/s);
  if (!m) return null;
  return { format: m[1].toLowerCase(), base64: m[2] };
}

/** 判断一个字符串像不像 base64（够长且无 URL 特征） */
function looksLikeBase64(s) {
  const t = String(s || '');
  if (t.length < 100) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/^data:image\//i.test(t)) return false;
  return /^[A-Za-z0-9+/=\s]+$/.test(t);
}

/** 通用取图：从常见字段里找图片地址（不认平台特有结构） */
export function genericExtractor(item) {
  const urls = [];
  const push = (u) => {
    if (typeof u === 'string' && u.trim()) urls.push(u.trim());
  };
  if (typeof item === 'string') push(item);
  else if (item && typeof item === 'object') {
    // 常见单值字段
    for (const k of ['url', 'src', 'image', 'imageUrl', 'image_url', 'original_url', 'originalUrl', 'cover']) {
      push(item[k]);
    }
    // 常见数组字段
    for (const k of ['images', 'pics', 'photos', 'footer_images', 'attachments']) {
      const arr = item[k];
      if (Array.isArray(arr)) {
        for (const it of arr) {
          if (typeof it === 'string') push(it);
          else if (it && typeof it === 'object') {
            push(it.url || it.src || it.original_url || it.originalUrl);
          }
        }
      }
    }
  }
  return [...new Set(urls)];
}

/** 下载图片 → { base64, format, bytes } */
export async function downloadBase64(url, { timeoutMs = 30000 } = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`下载图片 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < MIN_BYTES) throw new Error('图片过小/无效');
  const ct = String(r.headers.get('content-type') || '');
  const m = ct.match(/image\/([a-zA-Z0-9.+-]+)/);
  const format = m ? m[1].toLowerCase().replace('jpeg', 'jpg') : '';
  return { base64: buf.toString('base64'), format, bytes: buf.length };
}

/** 从 base64 头猜格式（下载和 data URI 都拿不到 content-type 时兜底） */
function sniffFormat(b64) {
  const head = String(b64).slice(0, 16);
  if (head.startsWith('/9j/')) return 'jpg';
  if (head.startsWith('iVBOR')) return 'png';
  if (head.startsWith('R0lGO')) return 'gif';
  if (head.startsWith('UklGR')) return 'webp';
  return '';
}

/** 从一个候选里取出 URL 字符串（兼容 extractor 直接返回图片对象的情况） */
function urlOf(c) {
  if (typeof c === 'string') return c.trim();
  if (c && typeof c === 'object') {
    return String(c.url || c.original_url || c.originalUrl || c.src || c.image || '').trim();
  }
  return '';
}

/**
 * 规范化图片输入 → 内部结构
 *
 * @param {Array} images URL / base64 / 对象
 * @param {{extractor?:Function, log?:Function, timeoutMs?:number}} [opt]
 * @returns {Promise<Array<{ref:string, url:string, base64:string, format:string,
 *   bytes:number, width?:number, height?:number, error?:string}>>}
 */
export async function normalizeImages(images, { extractor = null, log = () => {}, timeoutMs = 30000 } = {}) {
  const raw = Array.isArray(images) ? images : images ? [images] : [];
  const out = [];
  let seq = 0;

  for (const item of raw) {
    // ① 对象 → 先抽 URL（extractor 可能返回字符串，也可能返回图片对象）
    let candidates = [];
    if (item && typeof item === 'object' && !looksLikeBase64(item) && !parseDataUri(item)) {
      const fn = typeof extractor === 'function' ? extractor : genericExtractor;
      try {
        candidates = fn(item) || [];
      } catch (e) {
        log(`  [取图] extractor 异常：${e.message}`);
        candidates = [];
      }
    } else if (typeof item === 'string') {
      candidates = [item];
    }

    for (const rawCandidate of candidates) {
      const c = urlOf(rawCandidate);
      if (!c) continue;
      const meta = rawCandidate && typeof rawCandidate === 'object' ? rawCandidate : {};
      seq += 1;
      const ref = `img${seq}`;
      const dims = {
        ...(meta.width ? { width: Number(meta.width) } : {}),
        ...(meta.height ? { height: Number(meta.height) } : {}),
      };
      // ② data URI
      const du = parseDataUri(c);
      if (du) {
        out.push({
          ref,
          url: '',
          base64: du.base64,
          format: du.format,
          bytes: Math.floor((du.base64.length * 3) / 4),
          ...dims,
        });
        continue;
      }
      // ③ 裸 base64
      if (looksLikeBase64(c)) {
        out.push({
          ref,
          url: '',
          base64: String(c).replace(/\s+/g, ''),
          format: sniffFormat(c),
          bytes: Math.floor((String(c).length * 3) / 4),
          ...dims,
        });
        continue;
      }
      // ④ URL → 下载
      if (/^https?:\/\//i.test(c)) {
        try {
          const d = await downloadBase64(c, { timeoutMs });
          out.push({
            ref,
            url: c,
            base64: d.base64,
            format: d.format || sniffFormat(d.base64),
            bytes: d.bytes,
            ...dims,
          });
        } catch (e) {
          log(`  [取图] ${c.slice(0, 48)}… 下载失败：${e.message}`);
          out.push({ ref, url: c, base64: '', format: '', bytes: 0, error: e.message, ...dims });
        }
        continue;
      }
      log(`  [取图] 无法识别的图片来源，跳过：${String(c).slice(0, 48)}`);
    }
  }
  return out;
}

/** 图片指纹（缓存 key 用；优先 URL，其次 base64 内容 hash） */
export function fingerprint(img) {
  if (img.url) return createHash('sha1').update(img.url).digest('hex');
  return createHash('sha1').update(String(img.base64 || '').slice(0, 4096)).digest('hex');
}

/** 对外暴露：拆 data URI（测试与下游可能用到） */
export { parseDataUri, looksLikeBase64, sniffFormat, MIN_BYTES };