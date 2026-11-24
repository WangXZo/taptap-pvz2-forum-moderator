// OCR 通道契约离线测试 —— mock fetch，不打网络/不起 Python。
//
// 2026-11-24 重构：OCR 实现在独立 skill image-recognition-ai-ocr（自带 server.py，端口 8791）。
// 本测试验证该通道的请求/响应契约与降级行为。
//
// 跑：node scripts/test-ocr-bridge.mjs
import { pathToFileURL } from 'node:url';
import { resolveImageEntry } from './lib/image-recognition.mjs';

let pass = 0, fail = 0;
function t(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}

const entry = resolveImageEntry();
if (!entry) {
  console.error('✗ 找不到 image-recognition-ai-ocr 识图 skill');
  process.exit(1);
}
const pkg = await import(pathToFileURL(entry).href);
const { ocrImage, ocrImages, ocrHealth } = pkg;

const realFetch = globalThis.fetch;
let calls = [];
function mock(handler) { calls = []; globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return handler(String(url), opts); }; }
function restore() { globalThis.fetch = realFetch; }
function jsonRes(obj, status = 200) {
  return { ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

const cfg = { server: 'http://127.0.0.1:8791' };
const imgA = { ref: 'img1', base64: 'A'.repeat(200) };
const imgB = { ref: 'img2', base64: 'B'.repeat(200) };
const memCache = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };

console.log('\n== ocrImage 正常识别 ==');
{
  mock((url) => (url.endsWith('/ocr') ? jsonRes({ ok: true, text: '获得奖励 钻石334', boxes: [{ text: '获得奖励 钻石334', conf: 0.97 }] }) : jsonRes({}, 404)));
  const r = await ocrImage(imgA, { config: cfg });
  restore();
  t('返回识别文本', r.text === '获得奖励 钻石334');
  t('带逐行置信度', r.lines.length === 1 && r.lines[0].score === 0.97);
  t('POST /ocr 带 base64', JSON.parse(calls[0].opts.body).image.length > 100);
  t('没有 error', !r.error);
}

console.log('\n== 默认端口 8791 ==');
{
  mock(() => jsonRes({ ok: true, text: '' }));
  await ocrImage(imgA, { config: {} });
  restore();
  t('未配 server 时走 8791', calls[0].url.includes('127.0.0.1:8791'));
}

console.log('\n== ocrImages 批量 ==');
{
  mock((url) => jsonRes({ ok: true, text: 'x', boxes: [] }));
  const r = await ocrImages([imgA, imgB], { config: cfg });
  restore();
  t('逐张返回', r.length === 2 && r[0].ref === 'img1' && r[1].ref === 'img2');
}

console.log('\n== 降级：服务报错 / 无 base64 ==');
{
  mock(() => jsonRes({ error: 'boom' }, 500));
  const r = await ocrImage(imgA, { config: cfg });
  restore();
  t('服务 500 → 空文本不抛错', r.text === '' && Boolean(r.error));

  mock(() => jsonRes({ ok: false, error: 'fail' }));
  const r2 = await ocrImage(imgA, { config: cfg });
  restore();
  t('ok:false 也当失败', r2.text === '' && Boolean(r2.error));

  const r3 = await ocrImage({ ref: 'img3', base64: '' }, { config: cfg });
  t('无 base64 → no-base64 不请求', r3.error === 'no-base64');
}

console.log('\n== ocrHealth ==');
{
  mock((url) => (url.endsWith('/health') ? jsonRes({ ok: true, engine: 'rapidocr' }) : jsonRes({}, 404)));
  const h = await ocrHealth(cfg);
  restore();
  t('在线 → ok+engine', h.ok === true && h.engine === 'rapidocr');

  mock(() => { throw new Error('refused'); });
  const h2 = await ocrHealth(cfg);
  restore();
  t('离线 → ok:false 不抛错', h2.ok === false);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);