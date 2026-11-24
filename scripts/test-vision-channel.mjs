// 视觉渠道与多模态离线测试 —— mock fetch，不打网络。
//
// 2026-11-24 重构后的职责划分：
//   · 看图通道实现在独立 skill image-recognition-ai-ocr（vision.mjs）
//   · **本 skill 不注入 chatVision、不参与选模型**（大哥 2026-11-24：注入不该涉及模型）
//     —— 识图 skill 自己按 ②自备 KEY → ③DSH 路由 解析渠道
// 所以这里分三块测：
//   ① 本 skill llm.mjs 的多模态拼装仍完好（chatVision / resolveVisionChannels / isVisionModel）
//      —— 它是**库能力**，其它地方还要用
//   ② 识图 skill 的三级渠道解析（自备 KEY / DSH / 注入回落）
//   ③ describeImages 能正确消费渠道（含注入这条可选路径）
//
// 跑：node scripts/test-vision-channel.mjs
import { pathToFileURL } from 'node:url';
import { isVisionModel, resolveVisionChannels, chatVision } from './lib/llm.mjs';
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
const { describeImages, resolveVision } = pkg;

const realFetch = globalThis.fetch;
let calls = [];
function mock(handler) { calls = []; globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return handler(String(url), opts); }; }
function restore() { globalThis.fetch = realFetch; }
const imgRes = () => { const b = new Uint8Array(200); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => b.buffer }; };
const openaiRes = (text) => { const obj = { choices: [{ message: { content: text } }] }; return { ok: true, status: 200, text: async () => JSON.stringify(obj), json: async () => obj }; };
const anthRes = (text) => { const obj = { content: [{ text }] }; return { ok: true, status: 200, text: async () => JSON.stringify(obj), json: async () => obj }; };
const visionCfg = (over = {}) => ({ llm: { reuseDsh: false, vision: { apiKey: 'k', baseURL: 'http://x/v1', model: 'qwen-vl-max', ...over } }, image: { vision: {} } });

console.log('\n== ① 本 skill llm.mjs：isVisionModel（能力判定，不写死模型名）==');
{
  t('qwen-vl-max → 视觉', isVisionModel('qwen-vl-max') === true);
  t('qwen3.8-max → 非视觉', isVisionModel('qwen3.8-max') === false);
  t('omni 模型 → 视觉', isVisionModel('gemini-2.0-flash-omni') === true);
  t('白名单命中', isVisionModel('my-model', { llm: { visionModels: ['my-model'] } }) === true);
  t('白名单外且无能力词 → 非视觉', isVisionModel('plain-text', { llm: { visionModels: ['other'] } }) === false);
}

console.log('\n== ① 本 skill llm.mjs：resolveVisionChannels（他人key优先）==');
{
  const ch = await resolveVisionChannels(visionCfg());
  t('config.llm.vision 齐全 → config-vision', ch.length === 1 && ch[0].source === 'config-vision');
  t('模型/baseURL 正确', ch[0].model === 'qwen-vl-max' && ch[0].baseURL === 'http://x/v1');
  const none = await resolveVisionChannels({ llm: { reuseDsh: false } });
  t('无 vision 配置且不复用DSH → []', none.length === 0);
}

console.log('\n== ① 本 skill llm.mjs：chatVision 多模态拼装 ==');
{
  mock((url) => (url.endsWith('/chat/completions') ? openaiRes('图里是狂欢嘉年华活动，奖励钻石334') : imgRes()));
  const r = await chatVision(visionCfg(), { messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', base64: 'QUJD', mediaType: 'image/jpeg' }] }] });
  restore();
  t('返回识别文本', r.ok && r.text.includes('狂欢嘉年华'));
  const body = JSON.parse(calls[0].opts.body);
  const content = body.messages[0].content;
  t('content 是数组块', Array.isArray(content));
  t('image 块转 image_url + data URI', content.some((c) => c.type === 'image_url' && c.image_url.url.startsWith('data:image/jpeg;base64,')));
  t('text 块保留', content.some((c) => c.type === 'text' && c.text === '看图'));

  mock((url) => (url.endsWith('/v1/messages') ? anthRes('活动页面：紫手套碎片15') : imgRes()));
  const r2 = await chatVision(visionCfg({ api: 'anthropic-messages' }), { messages: [{ role: 'user', content: [{ type: 'image', base64: 'QUJD', mediaType: 'image/png' }, { type: 'text', text: '看图' }] }] });
  restore();
  t('anthropic 返回文本', r2.ok && r2.text.includes('紫手套'));
  const b2 = JSON.parse(calls[0].opts.body);
  const im = b2.messages[0].content.find((c) => c.type === 'image');
  t('image 块转 base64 source', im && im.source.type === 'base64' && im.source.media_type === 'image/png');

  mock((url) => (url.endsWith('/chat/completions') ? openaiRes('普通文本回复') : imgRes()));
  const r3 = await chatVision(visionCfg(), { messages: [{ role: 'user', content: '纯文本' }] });
  restore();
  const b3 = JSON.parse(calls[0].opts.body);
  t('string content 原样透传', b3.messages[0].content === '纯文本');
  t('文本回复正常', r3.text === '普通文本回复');
}

console.log('\n== ② 识图 skill describeImages（消费注入渠道）==');
{
  // 注入一个假渠道，不碰网络
  const injected = (cfg, opts) => {
    const hasImage = JSON.stringify(opts.messages).includes('"type":"image"');
    return Promise.resolve({ ok: true, text: hasImage ? '画面里有钻石与植物卡片' : '没收到图' });
  };
  const img = { ref: 'img1', base64: 'QUJD', format: 'jpg' };
  const r = await describeImages([img], { prompt: '识别图里的东西', config: { chatVision: injected } });
  t('注入渠道被调用', r.text.includes('钻石'));
  t('标注来源 injected', r.source === 'injected');

  const cache = new Map();
  const ca = { get: (k) => cache.get(k), set: (k, v) => cache.set(k, v) };
  const r1 = await describeImages([img], { prompt: 'p', config: { chatVision: injected }, cache: ca, cacheKey: 'k1' });
  const r2 = await describeImages([img], { prompt: 'p', config: { chatVision: injected }, cache: ca, cacheKey: 'k1' });
  t('缓存命中一致', r2.text === r1.text);
  t('缓存命中标记 cached', r2.cached === true);
}

console.log('\n== ② 识图 skill：无渠道 → 降级不抛错 ==');
{
  const r = await describeImages([{ ref: 'img1', base64: 'QUJD' }], { prompt: 'x', config: { env: {}, reuseDsh: false } });
  t('无渠道 → 空文本', r.text === '');
  t('无渠道 → error=no-channel', r.error === 'no-channel');

  const r2 = await describeImages([], { prompt: 'x', config: { chatVision: () => ({ ok: true, text: 'x' }) } });
  t('无图 → no-image', r2.error === 'no-image');

  t('resolveVision 注入优先', (await resolveVision({ chatVision: () => ({}) })).source === 'injected');
  t('resolveVision 全无 → null', (await resolveVision({ env: {}, reuseDsh: false })) === null);

  // 注入了但注入那套给不出渠道时，应当回落到自带/DSH（否则会白白降级）
  {
    const v = await resolveVision({ chatVision: () => ({ ok: false, error: 'no-channel' }) });
    t('注入存在时 resolveVision 不为 null', Boolean(v));
    t('注入失败时仍有 DSH 渠道可回落', Array.isArray(v.channels));
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);