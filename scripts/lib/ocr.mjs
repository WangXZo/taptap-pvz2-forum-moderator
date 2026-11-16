// S3 本地 OCR 桥接（RapidOCR 微服务客户端，2026-11-16）
//
// 下载图片（CDN img2-tc.tapimg.com 无防盗链，实测裸 GET 即可）→ base64 → POST 本地
// RapidOCR 微服务（scripts/ocr_server.py）→ 文本。适用：错误文案/数字/活动规则/图鉴说明文本。
//
// 服务未起 / 缺依赖 / 超时 → 降级返回空（不抛错），调用方按「没识别到」处理。
// 缓存接口 cache.get(key)/cache.set(key,val)（按图 url hash），避免重复识别。

import { createHash } from 'node:crypto';

const DEFAULT_SERVER = 'http://127.0.0.1:8790';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

async function downloadBase64(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://www.taptap.cn/' } });
  if (!r.ok) throw new Error(`下载图片 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 100) throw new Error('图片过小/无效');
  return buf.toString('base64');
}

/** 服务是否在线（体检用） */
export async function ocrHealth(config = {}) {
  const server = ((config?.image?.ocr?.server) || DEFAULT_SERVER).replace(/\/$/, '');
  try {
    const r = await fetch(server + '/health', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { ok: false };
    return { ok: true, ...(await r.json()) };
  } catch {
    return { ok: false };
  }
}

/**
 * 识别一组图片的文字。
 * @returns {{text:string, sources:string[]}}
 */
export async function ocrImages(images, { config = {}, log = () => {}, cache = null } = {}) {
  const ic = config?.image?.ocr || {};
  const server = (ic.server || DEFAULT_SERVER).replace(/\/$/, '');
  const timeoutMs = Number(ic.timeoutMs ?? 30000);
  const texts = [];
  for (const im of images || []) {
    if (!im?.url) continue;
    const key = 'ocr:' + createHash('sha1').update(im.url).digest('hex');
    const cached = cache?.get?.(key);
    if (cached) {
      if (cached.text) texts.push(cached.text);
      continue;
    }
    try {
      const b64 = await downloadBase64(im.url);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let r;
      try {
        r = await fetch(server + '/ocr', {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ image: b64 }),
        });
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) throw new Error(`OCR 服务 HTTP ${r.status}`);
      const j = await r.json();
      const text = String(j.text || '').trim();
      cache?.set?.(key, { text });
      if (text) texts.push(text);
    } catch (e) {
      log(`  [OCR] 跳过 ${String(im.url).slice(0, 48)}…：${e.message}`);
    }
  }
  return { text: texts.join('\n').trim(), sources: texts.length ? ['ocr'] : [] };
}