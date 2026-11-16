// 视觉渠道与多模态离线测试（S4，2026-11-16）—— mock fetch，不打网络。
// 跑：node scripts/test-vision-channel.mjs
import { isVisionModel, resolveVisionChannels, chatVision } from './lib/llm.mjs';
import { describeImages } from './lib/vision.mjs';

let pass = 0, fail = 0;
function t(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
}
const realFetch = globalThis.fetch;
let calls = [];
function mock(handler) { calls = []; globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return handler(String(url), opts); }; }
function restore() { globalThis.fetch = realFetch; }
const imgRes = () => { const b = new Uint8Array(200); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return { ok: true, status: 200, arrayBuffer: async () => b.buffer }; };
const openaiRes = (text) => { const obj = { choices: [{ message: { content: text } }] }; return { ok: true, status: 200, text: async () => JSON.stringify(obj), json: async () => obj }; };
const anthRes = (text) => { const obj = { content: [{ text }] }; return { ok: true, status: 200, text: async () => JSON.stringify(obj), json: async () => obj }; };
const visionCfg = (over = {}) => ({ llm: { reuseDsh: false, vision: { apiKey: 'k', baseURL: 'http://x/v1', model: 'qwen-vl-max', ...over } }, image: { vision: {} } });

console.log('\n== isVisionModel（能力判定，不写死模型名）==');
{
  t('qwen-vl-max → 视觉', isVisionModel('qwen-vl-max') === true);
  t('qwen3.8-max → 非视觉', isVisionModel('qwen3.8-max') === false);
  t('omni 模型 → 视觉', isVisionModel('gemini-2.0-flash-omni') === true);
  t('白名单命中', isVisionModel('my-model', { llm: { visionModels: ['my-model'] } }) === true);
  t('白名单外且无能力词 → 非视觉', isVisionModel('plain-text', { llm: { visionModels: ['other'] } }) === false);
}

console.log('\n== resolveVisionChannels（他人key优先）==');
{
  const ch = await resolveVisionChannels(visionCfg());
  t('config.llm.vision 齐全 → custom-vision', ch.length === 1 && ch[0].source === 'config-vision');
  t('模型/baseURL 正确', ch[0].model === 'qwen-vl-max' && ch[0].baseURL === 'http://x/v1');
  const none = await resolveVisionChannels({ llm: { reuseDsh: false } });
  t('无 vision 配置且不复用DSH → []', none.length === 0);
}

console.log('\n== chatVision 多模态拼装（openai image_url）==');
{
  mock((url) => url.endsWith('/chat/completions') ? openaiRes('图里是狂欢嘉年华活动，奖励钻石334') : imgRes());
  const r = await chatVision(visionCfg(), { messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', base64: 'QUJD', mediaType: 'image/jpeg' }] }] });
  restore();
  t('返回识别文本', r.ok && r.text.includes('狂欢嘉年华'));
  const body = JSON.parse(calls[0].opts.body);
  const content = body.messages[0].content;
  t('content 是数组块', Array.isArray(content));
  t('image 块转 image_url + data URI', content.some((c) => c.type === 'image_url' && c.image_url.url.startsWith('data:image/jpeg;base64,')));
  t('text 块保留', content.some((c) => c.type === 'text' && c.text === '看图'));
}

console.log('\n== chatVision 多模态拼装（anthropic image source）==');
{
  mock((url) => url.endsWith('/v1/messages') ? anthRes('活动页面：紫手套碎片15') : imgRes());
  const r = await chatVision(visionCfg({ api: 'anthropic-messages' }), { messages: [{ role: 'user', content: [{ type: 'image', base64: 'QUJD', mediaType: 'image/png' }, { type: 'text', text: '看图' }] }] });
  restore();
  t('anthropic 返回文本', r.ok && r.text.includes('紫手套'));
  const body = JSON.parse(calls[0].opts.body);
  const img = body.messages[0].content.find((c) => c.type === 'image');
  t('image 块转 base64 source', img && img.source.type === 'base64' && img.source.media_type === 'image/png' && img.source.data === 'QUJD');
}

console.log('\n== 纯文本消息不回归（string content 原样）==');
{
  mock((url) => url.endsWith('/chat/completions') ? openaiRes('普通文本回复') : imgRes());
  const r = await chatVision(visionCfg(), { messages: [{ role: 'user', content: '纯文本' }] });
  restore();
  const body = JSON.parse(calls[0].opts.body);
  t('string content 原样透传', body.messages[0].content === '纯文本');
  t('文本回复正常', r.text === '普通文本回复');
}

console.log('\n== describeImages（下载+看图+缓存+降级）==');
{
  const cache = new Map(); const ca = { get: (k) => cache.get(k), set: (k, v) => cache.set(k, v) };
  mock((url) => url.includes('img2-tc') ? imgRes() : openaiRes('活动页面：狂欢嘉年华，奖励钻石334'));
  const r = await describeImages([{ url: 'https://img2-tc.tapimg.com/x.jpg', format: 'jpeg' }], { config: visionCfg(), cache: ca });
  t('下载+看图返回文本', r.text.includes('狂欢嘉年华') && r.sources.includes('vlm'));
  const n = calls.length;
  const r2 = await describeImages([{ url: 'https://img2-tc.tapimg.com/x.jpg', format: 'jpeg' }], { config: visionCfg(), cache: ca });
  restore();
  t('缓存命中一致', r2.text === r.text);
  t('缓存命中不再发请求', calls.length === n);

  mock((url) => url.includes('img2-tc') ? imgRes() : openaiRes('x'));
  const noChan = await describeImages([{ url: 'https://img2-tc.tapimg.com/y.jpg' }], { config: { llm: { reuseDsh: false } } });
  restore();
  t('无视觉渠道 → 空文本降级不抛错', noChan.text === '' && noChan.sources.length === 0);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);