// T2 · 文字识别任务：图片 → 文字 + 标签
//
// 手段顺序：**OCR 优先**（本地免费、快、准）→ OCR 读不出且允许时 VLM 兜底。
// 为什么 OCR 优先：文字类内容 OCR 比 VLM 准且免费；VLM 只在画面杂乱、
// OCR 拿不到时兜底（VLM 读字会漏、会臆造）。

import { ocrImage } from '../ocr.mjs';
import { describeImages } from '../vision.mjs';
import { cacheKey } from '../cache.mjs';
import { fingerprint } from '../image.mjs';

/** VLM 兜底读字的提示词 */
const VLM_TEXT_PROMPT = `任务：把这张图片里能看到的文字**原样**读出来。
要求：
- 按画面从上到下、从左到右的顺序输出
- 保持原换行，不要合并成一段
- 看不清的字用「?」代替，不要猜
- 只输出读到的文字本身，不要任何说明、不要加标题`;

/**
 * 从文字内容派生通用标签（不依赖任何业务知识）
 * @param {string} text
 * @returns {string[]}
 */
export function deriveLabels(text) {
  const t = String(text || '');
  const labels = [];
  if (!t.trim()) return labels;
  if (/[\u4e00-\u9fa5]/.test(t)) labels.push('含中文');
  if (/[A-Za-z]{2,}/.test(t)) labels.push('含英文');
  if (/\d/.test(t)) labels.push('含数字');
  if (/(错误|失败|异常|重试|无效|error|failed|timeout)/i.test(t)) labels.push('错误提示');
  if (/https?:\/\//i.test(t)) labels.push('含链接');
  if (/\b\d{1,2}[:：]\d{2}\b|倒计时|剩余|还剩/.test(t)) labels.push('含时间');
  if (/(奖励|获得|领取|奖励内容|×|x\d)/i.test(t)) labels.push('含奖励');
  if (t.split('\n').filter((s) => s.trim()).length >= 5) labels.push('多行文本');
  if (t.length >= 200) labels.push('长文本');
  return [...new Set(labels)];
}

/**
 * 跑文字识别任务
 * @param {Array} images 规范化+预筛后的图片
 * @param {object} o
 * @param {boolean} [o.visionFallback=true] OCR 空时是否用 VLM 兜底
 */
export async function runText(images, {
  hint = '',
  context = '',
  materials = [],
  ocr = {},
  vision = {},
  visionFallback = true,
  visionEnabled = true,
  config = {},
  cache = null,
  log = () => {},
} = {}) {
  const results = [];
  const degraded = [];
  const methods = new Set();

  for (const img of images) {
    const out = { image: img.ref, text: '', lines: [], labels: [], method: 'none' };

    // ① OCR
    if (ocr.enabled !== false) {
      const key = cacheKey('ocr', fingerprint(img), 'ocr');
      const cached = cache?.get?.(key);
      const r = cached ? { text: cached.text || '', lines: cached.lines || [], ms: 0 } : await ocrImage(img, { config: ocr, log });
      if (!cached) cache?.set?.(key, { text: r.text, lines: r.lines });
      if (r.text) {
        out.text = r.text;
        out.lines = r.lines || [];
        out.method = 'ocr';
        methods.add('ocr');
      } else if (r.error) {
        degraded.push(`ocr:${img.ref}:${r.error}`);
      }
    }

    // ② OCR 没读到 → VLM 兜底
    const wantVision = visionEnabled !== false && vision.enabled !== false && visionFallback;
    if (!out.text && wantVision) {
      const key = cacheKey('text', fingerprint(img), hint || 'default');
      const r = await describeImages([img], {
        prompt: hint ? `${VLM_TEXT_PROMPT}\n补充要求：${hint}` : VLM_TEXT_PROMPT,
        context,
        materials,
        config: { ...vision, chatVision: vision.chatVision },
        log,
        cacheKey: key,
        cache,
        temperature: 0,
        maxTokens: 1500,
      });
      if (r.text) {
        out.text = r.text;
        out.method = 'vlm';
        methods.add('vlm');
      } else if (r.error) {
        degraded.push(`text-vlm:${img.ref}:${r.error}`);
      }
    }

    out.labels = deriveLabels(out.text);
    results.push(out);
  }
  return { results, degraded, methods: [...methods] };
}