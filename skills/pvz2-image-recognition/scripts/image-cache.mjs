// 图片识别结果缓存（S5，2026-11-16）：按图 url hash 缓存 OCR/VLM 结果，避免重复识别省钱。
// 落 data/image-cache.json；带 TTL（默认 168h=7天），过期自动失效。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadImageCache(file, { ttlHours = 168 } = {}) {
  let obj = {};
  try { obj = JSON.parse(readFileSync(file, 'utf8')) || {}; } catch { /* 首次无文件 */ }
  const m = new Map(Object.entries(obj));
  const ttlMs = ttlHours * 3600 * 1000;
  return {
    get(k) {
      const v = m.get(k);
      if (!v) return undefined;
      if (ttlMs > 0 && v.at && Date.now() - v.at > ttlMs) { m.delete(k); return undefined; }
      return v;
    },
    set(k, v) { m.set(k, { ...v, at: Date.now() }); },
    save() {
      try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(Object.fromEntries(m))); } catch { /* 落盘失败不阻断 */ }
    },
    get size() { return m.size; },
  };
}