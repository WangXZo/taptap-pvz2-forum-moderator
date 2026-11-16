// 图片流水线 M4 离线测试：缓存（TTL/落盘）+ 识别编排降级（2026-11-16）。
// 跑：node scripts/test-image-pipeline.mjs
import { loadImageCache } from './lib/image-cache.mjs';
import { enrichPostImages, defaultRecognize } from './lib/image.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, unlinkSync } from 'node:fs';

let pass = 0, fail = 0;
function t(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}
const img = { url: 'https://img2-tc.tapimg.com/x.jpg', format: 'jpeg', width: 100, height: 100 };
const item = { moment: { id_str: '1', topic: { type: 2, title: '活动奖励', footer_images: [img] } } };

console.log('\n== image-cache（TTL/落盘/重载）==');
{
  const file = join(tmpdir(), `img-cache-test-${Date.now()}.json`);
  const c = loadImageCache(file, { ttlHours: 168 });
  c.set('k1', { text: '缓存内容' });
  t('set/get 一致', c.get('k1').text === '缓存内容');
  t('get 带时间戳', typeof c.get('k1').at === 'number');
  c.save();
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  t('落盘含 k1', raw.k1 && raw.k1.text === '缓存内容');
  const c2 = loadImageCache(file, { ttlHours: 168 });
  t('重载命中', c2.get('k1').text === '缓存内容');
  // TTL 过期
  const c3 = loadImageCache(file, { ttlHours: 0.0001 }); // ~0.36s
  c3.set('k2', { text: 'x' });
  c3._expireHack = true;
  // 直接构造过期：把 at 改老
  const old = loadImageCache(file, { ttlHours: 1 });
  old.set('old', { text: '过期' });
  // 手动落一个过期条目
  const obj = JSON.parse(readFileSync(file, 'utf8'));
  obj.expired = { text: '旧', at: Date.now() - 999999999 };
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, JSON.stringify(obj));
  const c4 = loadImageCache(file, { ttlHours: 1 });
  t('过期条目 get 返回 undefined', c4.get('expired') === undefined);
  t('未过期条目仍在', c4.get('k1').text === '缓存内容');
  try { unlinkSync(file); } catch {}
}

console.log('\n== defaultRecognize 降级（各识别器关闭/缺依赖不抛错）==');
{
  const cfg = { image: { ocr: { enabled: false }, vision: { enabled: false }, features: { enabled: false } } };
  const r = await defaultRecognize([img], { config: cfg });
  t('全关闭 → 空文本不抛错', r.text === '' && Array.isArray(r.sources));
}

console.log('\n== enrichPostImages 走 defaultRecognize（关闭识别器→empty）==');
{
  const cfg = { image: { enabled: true, ocr: { enabled: false }, vision: { enabled: false }, features: { enabled: false } } };
  const r = await enrichPostImages(item, { config: cfg, title: '活动奖励是什么', text: '看图' });
  t('相关图但识别器全关 → empty-recognition', r.skipped === 'empty-recognition');
  t('文本不变（无识别内容）', r.text === '看图');
  t('images 仍提取', r.images.length === 1);
}

console.log('\n== enrichPostImages 注入识别器（多源合并）==');
{
  const cfg = { image: { enabled: true } };
  const rec = async () => ({ text: 'OCR文字\nVLM语义', sources: ['ocr', 'vlm'] });
  const r = await enrichPostImages(item, { config: cfg, title: '这活动怎么参加', text: '求助', recognize: rec });
  t('多源文本回灌', r.text.includes('OCR文字') && r.text.includes('VLM语义'));
  t('sources 合并', r.sources.includes('ocr') && r.sources.includes('vlm'));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);