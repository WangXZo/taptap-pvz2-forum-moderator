// OCR 通道：图片 → 文字
//
// 走本地 OCR 服务（本 skill自带 scripts/server.py，默认 127.0.0.1:8791）：
//   POST /ocr  ← { image: "<base64>" }  → { ok, text, boxes:[{text,conf}] }
//
// 服务不在 / 超时 / 报错 → **降级返回空**（不抛错），调用方按「没读到」处理。

const DEFAULT_SERVER = 'http://127.0.0.1:8791';

/** 服务是否在线（体检用） */
export async function ocrHealth(config = {}) {
  const server = String(config.server || DEFAULT_SERVER).replace(/\/$/, '');
  try {
    const r = await fetch(server + '/health', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, ...(await r.json()) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 识别一张图的文字
 * @returns {Promise<{text:string, lines:Array<{text:string,score:number|null}>, ms:number, error?:string}>}
 */
export async function ocrImage(img, { config = {}, log = () => {} } = {}) {
  const server = String(config.server || DEFAULT_SERVER).replace(/\/$/, '');
  const timeoutMs = Number(config.timeoutMs ?? 30000);
  const t0 = Date.now();
  if (!img?.base64) return { text: '', lines: [], ms: 0, error: 'no-base64' };
  try {
    const r = await fetch(server + '/ocr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: img.base64 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`OCR 服务 HTTP ${r.status}`);
    const j = await r.json();
    if (j && j.ok === false) throw new Error(j.error || 'OCR 服务返回失败');
    const text = String(j.text || '').trim();
    const lines = (j.boxes || j.lines || []).map((b) => ({
      text: String(b.text || ''),
      score: b.conf ?? b.score ?? null,
    }));
    return { text, lines, ms: Date.now() - t0 };
  } catch (e) {
    log(`  [OCR] ${img.ref || ''} 跳过：${e.message}`);
    return { text: '', lines: [], ms: Date.now() - t0, error: e.message };
  }
}

/** 批量识别（逐张） */
export async function ocrImages(images, { config = {}, log = () => {} } = {}) {
  const out = [];
  for (const img of images || []) {
    out.push({ ref: img.ref, ...(await ocrImage(img, { config, log })) });
  }
  return out;
}