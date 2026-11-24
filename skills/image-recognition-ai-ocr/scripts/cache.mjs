// 结果缓存：按「图片指纹 + 任务签名」缓存识别结果，避免重复花钱。
//
// 为什么 key 里要带任务签名：同一张图，问「是不是错误弹窗」和「读出文字」
// 是两个不同的问题、答案不同 —— 只按图 hash 缓存会串答案。
//
// 用法：
//   const cache = loadCache('data/image-cache.json', { ttlHours: 168 });
//   cache.get(key) / cache.set(key, value) / cache.save()

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

/** 生成缓存 key：图片指纹 + 任务签名 */
export function cacheKey(kind, imageRef, signature = '') {
  return createHash('sha1').update(`${kind}|${imageRef}|${signature}`).digest('hex');
}

/**
 * @param {string|null} file 落盘路径（null = 纯内存）
 * @param {{ttlHours?:number}} [opt]
 */
export function loadCache(file, { ttlHours = 168 } = {}) {
  let obj = {};
  if (file) {
    try {
      obj = JSON.parse(readFileSync(file, 'utf8')) || {};
    } catch {
      /* 首次无文件 */
    }
  }
  const m = new Map(Object.entries(obj));
  const ttlMs = Number(ttlHours) * 3600 * 1000;
  return {
    get(k) {
      const v = m.get(k);
      if (!v) return undefined;
      if (ttlMs > 0 && v.at && Date.now() - v.at > ttlMs) {
        m.delete(k);
        return undefined;
      }
      return v.value !== undefined ? v.value : v;
    },
    set(k, value) {
      m.set(k, { value, at: Date.now() });
    },
    save() {
      if (!file) return;
      try {
        mkdirSync(dirname(file), { recursive: true });
        const plain = {};
        for (const [k, v] of m) plain[k] = v;
        writeFileSync(file, JSON.stringify(plain));
      } catch {
        /* 落盘失败不阻断 */
      }
    },
    get size() {
      return m.size;
    },
  };
}

/** 内存缓存（不落盘，用于单次调用或测试） */
export function memoryCache() {
  return loadCache(null);
}