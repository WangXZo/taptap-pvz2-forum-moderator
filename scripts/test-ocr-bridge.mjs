// OCR 桥接契约离线测试（S3，2026-11-16）—— mock fetch，不打网络/不起 Python。
// 跑：node scripts/test-ocr-bridge.mjs
import { ocrImages, ocrHealth } from './lib/ocr.mjs';

let pass = 0, fail = 0;
function t(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}
const realFetch = globalThis.fetch;
let calls = [];
function imgRes() {
  const bytes = new Uint8Array(200); bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff;
  return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
}
function jsonRes(obj, status = 200) {
  return { ok: status < 400, status, json: async () => obj };
}
function mock(handler) { calls = []; globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return handler(String(url), opts); }; }
function restore() { globalThis.fetch = realFetch; }
const cfg = { image: { ocr: { server: 'http://127.0.0.1:8790' } } };
const imgs = [{ url: 'https://img2-tc.tapimg.com/a.jpg' }, { url: 'https://img2-tc.tapimg.com/b.jpg' }];
const memCache = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), _m: m }; };

console.log('\n== ocrImages 正常识别 ==');
{
  mock((url) => url.endsWith('/ocr') ? jsonRes({ text: '获得奖励 钻石334' }) : imgRes());
  const r = await ocrImages([imgs[0]], { config: cfg });
  restore();
  t('返回识别文本', r.text === '获得奖励 钻石334');
  t('sources=[ocr]', r.sources.includes('ocr'));
  t('先下载图再 POST /ocr', calls.length === 2 && calls[1].url.endsWith('/ocr'));
  t('POST body 带 base64 image', JSON.parse(calls[1].opts.body).image.length > 100);
}

console.log('\n== 多图合并 ==');
{
  let n = 0;
  mock((url) => url.endsWith('/ocr') ? jsonRes({ text: `文本${++n}` }) : imgRes());
  const r = await ocrImages(imgs, { config: cfg });
  restore();
  t('两图文本合并', r.text.includes('文本1') && r.text.includes('文本2'));
}

console.log('\n== 缓存命中不重复识别 ==');
{
  const cache = memCache();
  mock((url) => url.endsWith('/ocr') ? jsonRes({ text: '首次' }) : imgRes());
  await ocrImages([imgs[0]], { config: cfg, cache });
  const firstCalls = calls.length;
  const r2 = await ocrImages([imgs[0]], { config: cfg, cache });
  restore();
  t('二次命中缓存文本一致', r2.text === '首次');
  t('二次未再发请求', calls.length === firstCalls);
}

console.log('\n== 降级：服务报错/下载失败 ==');
{
  mock((url) => url.endsWith('/ocr') ? jsonRes({ error: 'boom' }, 500) : imgRes());
  const r = await ocrImages([imgs[0]], { config: cfg });
  restore();
  t('服务 500 → 空文本不抛错', r.text === '' && r.sources.length === 0);

  mock(() => { throw new Error('network down'); });
  const r2 = await ocrImages([imgs[0]], { config: cfg });
  restore();
  t('下载异常 → 空文本不抛错', r2.text === '');

  mock((url) => url.endsWith('/ocr') ? jsonRes({ text: '' }) : imgRes());
  const r3 = await ocrImages([imgs[0]], { config: cfg });
  restore();
  t('识别空 → sources 为空', r3.text === '' && r3.sources.length === 0);
}

console.log('\n== ocrHealth ==');
{
  mock((url) => url.endsWith('/health') ? jsonRes({ ok: true, engine: 'rapidocr' }) : jsonRes({}, 404));
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