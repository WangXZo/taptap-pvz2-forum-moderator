// 图片识别流水线离线测试：缓存 + 识图 skill 编排 + 组合任务
//
// 2026-11-24 重构：实现已在独立 skill image-recognition-ai-ocr（任务驱动）。
// 本测试验证「本 skill 侧取到的实现能正常跑」，并用注入的假 recognize 测回灌。
//
// 跑：node scripts/test-image-pipeline.mjs
import { pathToFileURL } from 'node:url';
import { resolveImageEntry, enrichPostImages } from './lib/image-recognition.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

const entry = resolveImageEntry();
t('找到识图 skill 入口', Boolean(entry), String(entry || ''));
if (!entry) {
  console.log('\n结果：0 通过 / 1 失败（识图 skill 缺失）');
  process.exit(1);
}
const pkg = await import(pathToFileURL(entry).href);

const img = { ref: 'img1', url: 'https://img2-tc.tapimg.com/x.jpg', base64: 'A'.repeat(200), format: 'jpg', bytes: 200 };
const item = { moment: { id_str: '1', topic: { type: 2, title: '活动奖励', footer_images: [{ original_url: 'https://img2-tc.tapimg.com/x.jpg', original_format: 'jpeg' }] } } };

console.log('\n== 缓存（识图 skill 实现）==');
{
  const file = join(tmpdir(), `img-cache-test-${Date.now()}.json`);
  const c = pkg.loadCache(file, { ttlHours: 168 });
  c.set('k1', { text: '缓存内容' });
  t('set/get 一致', c.get('k1').text === '缓存内容');
  c.save();
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  t('落盘含 k1', raw.k1 && raw.k1.value.text === '缓存内容');
  const c2 = pkg.loadCache(file, { ttlHours: 168 });
  t('重载命中', c2.get('k1').text === '缓存内容');
  // 过期
  const obj = JSON.parse(readFileSync(file, 'utf8'));
  obj.expired = { value: { text: '旧' }, at: Date.now() - 999999999 };
  writeFileSync(file, JSON.stringify(obj));
  const c3 = pkg.loadCache(file, { ttlHours: 1 });
  t('过期条目 get 返回 undefined', c3.get('expired') === undefined);
  t('未过期条目仍在', c3.get('k1').text === '缓存内容');
  try { unlinkSync(file); } catch {}
}

console.log('\n== 任务归一化与参数校验 ==');
{
  t('单一任务', JSON.stringify(pkg.normalizeTasks({ task: 'text' }).tasks) === '["text"]');
  t('组合任务', JSON.stringify(pkg.normalizeTasks({ tasks: ['text', 'feature'] }).tasks) === '["text","feature"]');
  t('未知任务报错', Boolean(pkg.normalizeTasks({ task: 'nope' }).error));
  const bad = await pkg.recognize({ task: 'text', images: [] });
  t('缺 images → ok:false 不抛错', bad.ok === false);
}

console.log('\n== 识别器全关 → 空结果不抛错 ==');
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const b = new Uint8Array(200); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
    return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => b.buffer };
  };
  const r = await pkg.recognize({
    tasks: ['text', 'feature'],
    images: [item],
    extractor: (p) => p.moment.topic.footer_images.map((x) => x.original_url),
    options: {
      ocr: { enabled: false },
      vision: { enabled: false },
      features: { enabled: false },
      prefilter: { quality: true, vlmBinary: false },
    },
  });
  globalThis.fetch = realFetch;
  t('组合任务 ok', r.ok === true);
  // 2026-11-25 起结果统一「一图一条」：text/description/features 都在同一行
  t('结果一图一条', Array.isArray(r.results) && r.results.length === 1);
  t('text 结果为空文本', r.results[0].text === '' && r.results[0].chars === 0);
  t('feature 结果为空描述', r.results[0].description === '');
  t('有降级说明', r.meta.degraded.length >= 1);
}

console.log('\n== enrichPostImages 用真实识图 skill（注入假 fetch）==');
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/ocr')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, text: '活动奖励：钻石334', boxes: [] }) };
    }
    const b = new Uint8Array(200); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
    return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => b.buffer };
  };
  const cfg = {
    image: {
      enabled: true,
      features: { enabled: false },
      ocr: { enabled: true, server: 'http://127.0.0.1:8791' },
      vision: { enabled: false },
      prefilter: { quality: true, vlmBinary: false },
    },
  };
  const r = await enrichPostImages(item, { config: cfg, title: '活动奖励是什么', text: '看图' });
  globalThis.fetch = realFetch;
  t('走真实识图 skill 拿到 OCR 文本', r.imageText.includes('钻石334'), r.imageText || r.skipped);
  t('文本已回灌', r.text.includes('[图片内容]'));
  t('sources 含 ocr', r.sources.includes('ocr'));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);