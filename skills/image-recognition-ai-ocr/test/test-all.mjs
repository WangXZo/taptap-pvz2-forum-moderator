// image-recognition-ai-ocr 自测（全离线：mock fetch，不打网络、不起 Python）
//
// 跑：node test/test-all.mjs
// 覆盖：任务归一化 / 取图规范化 / 缓存 / 资料层 / 预筛 / JSON 解析 /
//       三类任务的纯函数 / recognize() 编排 / 降级语义

import { recognize, normalizeTasks, TASKS } from '../scripts/index.mjs';
import { normalizeImages, fingerprint, parseDataUri, looksLikeBase64, genericExtractor } from '../scripts/image.mjs';
import { loadCache, memoryCache, cacheKey } from '../scripts/cache.mjs';
import { loadMaterials, formatMaterials, learnMaterial } from '../scripts/materials.mjs';
import { qualityPrefilter, parseBinaryAnswer, vlmBinaryPrefilter } from '../scripts/prefilter.mjs';
import { tryParseJson, toConfidence } from '../scripts/json.mjs';
import { buildMatchPrompt, normalizeMatchResult } from '../scripts/tasks/match.mjs';
import { deriveLabels } from '../scripts/tasks/text.mjs';
import { buildFeaturePrompt } from '../scripts/tasks/feature.mjs';
import {
  resolveVision,
  resolveOwnKey,
  resolveVisionChannels,
  resolveDshVisionChannels,
  isVisionModel,
  supportsImageInput,
  toApiContent,
  callOnce,
} from '../scripts/vision.mjs';
import { parseProviders, parseCredRefs, modelIds } from '../scripts/dsh-routes.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

let pass = 0;
let fail = 0;
function t(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? '  -> ' + extra : ''}`);
  }
}
function section(name) {
  console.log(`\n== ${name} ==`);
}

// ── 公共 mock ──
const realFetch = globalThis.fetch;
let calls = [];
function mockFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  };
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}
const imgRes = () => {
  const b = new Uint8Array(200);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => b.buffer };
};
const jsonRes = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });
const openaiRes = (text) => {
  const obj = { choices: [{ message: { content: text } }] };
  return { ok: true, status: 200, text: async () => JSON.stringify(obj), json: async () => obj };
};

// ═══════════════ 1. 任务归一化 ═══════════════
section('normalizeTasks');
{
  t('单一 task', JSON.stringify(normalizeTasks({ task: 'text' }).tasks) === '["text"]');
  t('多任务 tasks', JSON.stringify(normalizeTasks({ tasks: ['text', 'feature'] }).tasks) === '["text","feature"]');
  t('task 传数组', JSON.stringify(normalizeTasks({ task: ['match', 'text'] }).tasks) === '["match","text"]');
  t('去重保序', JSON.stringify(normalizeTasks({ tasks: ['text', 'text', 'feature'] }).tasks) === '["text","feature"]');
  t('大小写容忍', JSON.stringify(normalizeTasks({ task: 'TEXT' }).tasks) === '["text"]');
  t('未知任务 → error', Boolean(normalizeTasks({ task: 'nope' }).error));
  t('缺任务 → error', Boolean(normalizeTasks({}).error));
  t('TASKS 常量', TASKS.join(',') === 'match,text,feature');
}

// ═══════════════ 2. 取图规范化 ═══════════════
section('normalizeImages / 取图');
{
  const du = parseDataUri('data:image/png;base64,iVBORw0KGgo=');
  t('解析 data URI', du && du.format === 'png' && du.base64 === 'iVBORw0KGgo=');
  t('非 data URI → null', parseDataUri('https://x/a.jpg') === null);
  t('looksLikeBase64 认长串', looksLikeBase64('A'.repeat(200)) === true);
  t('URL 不算 base64', looksLikeBase64('https://x/' + 'A'.repeat(200)) === false);

  const r1 = await normalizeImages([{ url: 'https://img/x.jpg' }]);
  t('对象直取 url', r1.length === 1 && r1[0].url === 'https://img/x.jpg');

  const r2 = await normalizeImages([{ images: [{ url: 'https://a/1.jpg' }, { src: 'https://a/2.jpg' }] }]);
  t('通用数组字段', r2.length === 2);

  const r3 = await normalizeImages([{ footer_images: [{ original_url: 'https://a/3.jpg' }] }]);
  t('footer_images 原始地址', r3.length === 1 && r3[0].url === 'https://a/3.jpg');

  t('genericExtractor 去重', genericExtractor({ url: 'https://a/x.jpg', image: 'https://a/x.jpg' }).length === 1);

  // data URI 直用（不下载）
  const r4 = await normalizeImages(['data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==']);
  t('data URI 不走网络', r4.length === 1 && r4[0].format === 'png' && !r4[0].url);

  // URL 下载（mock）
  mockFetch(() => imgRes());
  const r5 = await normalizeImages(['https://img/x.jpg']);
  restoreFetch();
  t('URL 下载得 base64', r5[0].base64.length > 0 && r5[0].bytes >= 100);
  t('下载带 UA', calls[0].opts.headers['User-Agent'].includes('Mozilla'));

  // 下载失败 → 带 error 但仍占位
  mockFetch(() => ({ ok: false, status: 404 }));
  const r6 = await normalizeImages(['https://img/bad.jpg']);
  restoreFetch();
  t('下载失败记 error', r6.length === 1 && Boolean(r6[0].error) && r6[0].base64 === '');

  t('指纹用 url', fingerprint({ url: 'https://a/x.jpg' }) === fingerprint({ url: 'https://a/x.jpg' }));
  t('不同 url 指纹不同', fingerprint({ url: 'https://a/x.jpg' }) !== fingerprint({ url: 'https://a/y.jpg' }));
}

// ═══════════════ 3. 缓存 ═══════════════
section('cache');
{
  const file = join(tmpdir(), `ir-cache-${Date.now()}.json`);
  const c = loadCache(file, { ttlHours: 168 });
  c.set('k1', { text: '缓存值' });
  t('set/get 一致', c.get('k1').text === '缓存值');
  c.save();
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  t('落盘含值', raw.k1 && raw.k1.value.text === '缓存值');
  const c2 = loadCache(file, { ttlHours: 168 });
  t('重载命中', c2.get('k1').text === '缓存值');
  // 过期：直接往文件里写一条很老的记录
  const obj = JSON.parse(readFileSync(file, 'utf8'));
  obj.expired = { value: { text: '旧' }, at: Date.now() - 999999999 };
  writeFileSync(file, JSON.stringify(obj));
  const c3 = loadCache(file, { ttlHours: 1 });
  t('TTL 过期返回 undefined', c3.get('expired') === undefined);
  t('未过期条目仍在', c3.get('k1').text === '缓存值');
  try {
    unlinkSync(file);
  } catch {}

  t('内存缓存可用', memoryCache().get('nope') === undefined);
  t('cacheKey 随任务签名变化', cacheKey('ocr', 'abc', 'a') !== cacheKey('ocr', 'abc', 'b'));
  t('cacheKey 同参稳定', cacheKey('ocr', 'abc', 'a') === cacheKey('ocr', 'abc', 'a'));
}

// ═══════════════ 4. 资料层 ═══════════════
section('materials');
{
  const builtin = loadMaterials({});
  t('读到内置资料', builtin.length >= 1);
  t('含场景分类法', builtin.some((m) => m.id === 'scene-types'));
  t('内置来源标记', builtin.find((m) => m.id === 'scene-types').source === 'builtin');

  const withCaller = loadMaterials({ extra: [{ id: 'x', title: '补充', content: '内容' }] });
  t('调用方资料并入', withCaller.some((m) => m.source === 'caller'));

  // 同 id 覆盖
  const override = loadMaterials({ extra: [{ id: 'scene-types', title: '我的分类', content: '覆盖内容' }] });
  t('同 id 调用方覆盖内置', override.find((m) => m.id === 'scene-types').content === '覆盖内容');

  // 对象形式
  const asObj = loadMaterials({ extra: { 标题甲: '内容甲' } });
  t('对象形式资料', asObj.some((m) => m.title === '标题甲'));

  // 格式化
  const fmt = formatMaterials(withCaller, { maxChars: 2000 });
  t('格式化含内容', fmt.includes('补充') || fmt.includes('内容'));
  t('超长截断', formatMaterials([{ content: 'x'.repeat(5000) }], { maxChars: 100 }).length <= 130);

  // 积累
  const lf = join(tmpdir(), `ir-mat-${Date.now()}.json`);
  t('learnMaterial 写入', learnMaterial(lf, { id: 'learned1', title: '学到1', content: '内容1' }) === true);
  const withLearned = loadMaterials({ learnedFile: lf });
  t('积累资料被加载', withLearned.some((m) => m.id === 'learned1' && m.source === 'learned'));
  try {
    unlinkSync(lf);
  } catch {}

  t('无内容条目被过滤', loadMaterials({ extra: [{ id: 'e', content: '' }] }).every((m) => m.content));
}

// ═══════════════ 5. 预筛 ═══════════════
section('prefilter');
{
  const ok = { ref: 'img1', base64: 'A'.repeat(200), bytes: 200 };
  const small = { ref: 'img2', base64: 'A'.repeat(20), bytes: 20 };
  const broken = { ref: 'img3', base64: '', error: 'HTTP 404' };

  const q = qualityPrefilter([ok, small, broken, { ...ok, ref: 'img4' }], { enabled: true });
  t('正常图保留', q.kept.some((x) => x.ref === 'img1'));
  t('过小被挡', q.skipped.some((x) => x.ref === 'img2' && x.reason === 'too-small'));
  t('下载失败被挡', q.skipped.some((x) => x.ref === 'img3'));
  t('重复图被挡', q.skipped.some((x) => x.ref === 'img4' && x.reason === 'duplicate'));
  t('关掉预筛则全保留', qualityPrefilter([ok, small], { enabled: false }).kept.length === 2);

  t('二分类「有」→ true', parseBinaryAnswer('有') === true);
  t('二分类「无」→ false', parseBinaryAnswer('无') === false);
  t('二分类带句号', parseBinaryAnswer('有。') === true);
  t('二分类空 → null', parseBinaryAnswer('') === null);
  // 「无文字但有画面」= 明确说了有画面内容 → 判为「有」，保留（宁可多识别）
  t('既提无又提有 → 按有处理（保留）', parseBinaryAnswer('无文字但有画面') === true);
  t('英文 no', parseBinaryAnswer('no') === false);

  // 无看图渠道 → 整体跳过，不应逐张尝试（实测 13 张图白等 40+ 秒）
  const manyImgs = Array.from({ length: 13 }, (_, i) => ({ ref: `img${i + 1}`, base64: 'A'.repeat(200), bytes: 200 }));
  let vlmCalls = 0;
  mockFetch((url) => {
    vlmCalls++;
    return jsonRes({}, 500);
  });
  const vb = await vlmBinaryPrefilter(manyImgs, { enabled: true, config: { env: {}, reuseDsh: false } });
  restoreFetch();
  t('无渠道 → 全部保留', vb.kept.length === 13);
  t('无渠道 → 一次都不调模型', vlmCalls === 0);
  t('无渠道 → 不产 skipped', vb.skipped.length === 0);
}

// ═══════════════ 6. JSON 解析 ═══════════════
section('json 解析');
{
  t('纯 JSON', tryParseJson('{"a":1}')?.a === 1);
  t('```json 围栏', tryParseJson('```json\n{"a":2}\n```')?.a === 2);
  t('前后带解释', tryParseJson('好的，结果如下：{"a":3} 以上。')?.a === 3);
  t('非法 → null', tryParseJson('完全不是 JSON') === null);
  t('空 → null', tryParseJson('') === null);

  t('置信度原样', toConfidence(0.93) === 0.93);
  t('百分数归一', toConfidence(92) === 0.92);
  t('超范围夹住', toConfidence(150) === 1);
  t('负值归零', toConfidence(-5) === 0);
  t('字符串百分号', toConfidence('85%') === 0.85);
  t('非法给 fallback', toConfidence('abc', 0) === 0);
}

// ═══════════════ 7. T1 判断纯函数 ═══════════════
section('match 纯函数');
{
  const intents = [
    { id: 'error', label: '错误弹窗' },
    { id: 'activity', label: '活动页' },
  ];
  const p = buildMatchPrompt(intents, { hint: '看画面主体' });
  t('提示词含意图 id', p.includes('id="error"') && p.includes('id="activity"'));
  t('提示词含补充说明', p.includes('看画面主体'));
  t('提示词要求 JSON', p.includes('JSON'));

  const norm = normalizeMatchResult(
    { matches: [{ intent: 'error', confidence: 0.93, reason: '红框' }, { intent: 'activity', confidence: 0.05 }] },
    intents
  );
  t('归一化两条', norm.length === 2);
  t('按置信度降序', norm[0].intent === 'error' && norm[0].confidence === 0.93);
  t('带 label', norm[0].label === '错误弹窗');

  const best = normalizeMatchResult(
    { matches: [{ intent: 'error', confidence: 0.9 }, { intent: 'activity', confidence: 0.2 }] },
    intents,
    { onlyBest: true }
  );
  t('onlyBest 只留一条', best.length === 1 && best[0].intent === 'error');

  const missing = normalizeMatchResult({ matches: [{ intent: 'error', confidence: 0.9 }] }, intents);
  t('漏答意图补 0', missing.length === 2 && missing.find((m) => m.intent === 'activity').missing === true);

  const bogus = normalizeMatchResult({ matches: [{ intent: 'unknown_id', confidence: 0.9 }] }, intents);
  t('非法意图 id 被丢弃并补齐', bogus.length === 2 && !bogus.some((m) => m.intent === 'unknown_id'));

  const pct = normalizeMatchResult({ matches: [{ intent: 'error', confidence: 93 }] }, intents);
  t('整数置信度归一', pct[0].confidence === 0.93);
}

// ═══════════════ 8. T2 标签派生 ═══════════════
section('text 标签派生');
{
  t('中文', deriveLabels('网络连接失败').includes('含中文'));
  t('数字', deriveLabels('错误码 10086').includes('含数字'));
  t('英文', deriveLabels('timeout error').includes('含英文'));
  t('错误提示', deriveLabels('操作失败请重试').includes('错误提示'));
  t('链接', deriveLabels('见 https://x.com').includes('含链接'));
  t('奖励', deriveLabels('获得钻石×334').includes('含奖励'));
  t('空文本无标签', deriveLabels('').length === 0);
  t('多行文本', deriveLabels('a\nb\nc\nd\ne').includes('多行文本'));
  t('长文本', deriveLabels('字'.repeat(250)).includes('长文本'));
  t('标签去重', new Set(deriveLabels('失败 error 123')).size === deriveLabels('失败 error 123').length);
}

// ═══════════════ 9. T3 prompt ═══════════════
section('feature prompt');
{
  t('含任务说明', buildFeaturePrompt('识别植物').includes('识别植物'));
  t('缺说明给通用任务', buildFeaturePrompt('').includes('描述这张图片'));
  t('要求不编造', buildFeaturePrompt('x').includes('不要编造'));
}

// ═══════════════ 10. 渠道解析（三级：注入 → 自备KEY → DSH 路由）═══════════════
section('渠道解析 · 自备 KEY（config / 环境变量）');
{
  t('无配置 → null', resolveOwnKey({ env: {} }) === null);

  const envCh = resolveOwnKey({ env: { IR_VISION_API_KEY: 'k', IR_VISION_BASE_URL: 'http://x/v1', IR_VISION_MODEL: 'm' } });
  t('环境变量齐全 → 渠道', Boolean(envCh) && envCh.model === 'm' && envCh.baseURL === 'http://x/v1');
  t('环境变量来源标记', envCh.source === 'env');

  const cfgCh = resolveOwnKey({ apiKey: 'k2', baseURL: 'http://z/v1/', model: 'm2', env: {} });
  t('config 直配优先于环境变量', cfgCh.source === 'config' && cfgCh.model === 'm2');
  t('baseURL 去掉尾斜杠', cfgCh.baseURL === 'http://z/v1');
  t('config 三项不全 → 不算（落回环境）', resolveOwnKey({ apiKey: 'k', baseURL: '', model: 'm', env: {} }) === null);

  const openaiFb = resolveOwnKey({ env: { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'http://y/v1', OPENAI_MODEL: 'm3' } });
  t('OPENAI_ 兜底命名也认', Boolean(openaiFb) && openaiFb.apiKey === 'k');
}

section('渠道解析 · 视觉能力判定');
{
  t('qwen-vl-max → 视觉', isVisionModel('qwen-vl-max'));
  t('gpt-4o → 非视觉（无能力词）', isVisionModel('gpt-4o') === false);
  t('omni → 视觉', isVisionModel('gemini-2.0-flash-omni'));
  t('vision → 视觉', isVisionModel('some-vision-model'));
  t('multimodal → 视觉', isVisionModel('x-multimodal'));
  t('白名单命中', isVisionModel('my-plain-model', { visionModels: ['my-plain-model'] }));
  t('白名单外 + 无能力词 → 非视觉', isVisionModel('plain-text', { visionModels: ['other'] }) === false);
}

section('渠道解析 · DSH 路由（复用宿主，不写死模型名）');
{
  // 造一份合成的 DSH 配置（缩进照真实 cordis.patch.yml：chain 项 10 空格、model 12 空格）
  const patch = `
llm-pi-ai:
    providers:
      p-alpha:
        apiKeyEnv: ALPHA_KEY
        api: openai-completions
        baseURL: https://alpha.example/v1
        models:
          - id: alpha-plain
          - id: alpha-vl-1
      p-beta:
        apiKeyEnv: BETA_KEY
        api: anthropic-messages
        baseURL: https://beta.example
        models:
          - id: beta-vision
      p-nokey:
        apiKeyEnv: MISSING_KEY
        baseURL: https://nokey.example/v1
        models:
          - id: nokey-vl
      p-gamma:
        apiKeyEnv: GAMMA_KEY
        api: openai-completions
        baseURL: https://gamma.example/v1
        models:
          - id: gamma-text-only
            input:
              - text
          - id: gamma-plain-name
            input:
              - text
              - image
llm-failover:
        chain:
          # 注释行不应打断解析
          - provider: p-beta
            model: beta-vision
          - provider: p-alpha
            model: alpha-plain
`;
  const { providers, chain } = parseProviders(patch);
  t('解析出 4 个 provider', Object.keys(providers).length === 4);
  t('provider 字段正确', providers['p-alpha'].baseURL === 'https://alpha.example/v1');
  t('api 风格正确', providers['p-beta'].api === 'anthropic-messages');
  t('模型清单解析', modelIds(providers['p-alpha']).join(',') === 'alpha-plain,alpha-vl-1');
  t('chain 解析 2 条', chain.length === 2 && chain[0].provider === 'p-beta');

  const creds = parseCredRefs(`
refs:
  ALPHA_KEY: sk-alpha
  BETA_KEY: "sk-beta"
  GAMMA_KEY: sk-gamma
other:
  X: y
`);
  t('凭据解析（去引号）', creds.ALPHA_KEY === 'sk-alpha' && creds.BETA_KEY === 'sk-beta');
  t('refs 段外的键不混入', creds.X === undefined);

  // 模型按对象解析，保留声明的输入能力
  t('模型解析成对象', typeof providers['p-gamma'].models[0] === 'object');
  t('声明 input 能力被读出来', providers['p-gamma'].models[1].input.includes('image'));
  t('只声明 text 的模型 input 不含 image', !providers['p-gamma'].models[0].input.includes('image'));

  const routes = { providers, chain, creds, hasPatch: true };
  const chs = await resolveDshVisionChannels({}, routes);
  t('只挑视觉模型（alpha-plain 被排除）', !chs.some((c) => c.model === 'alpha-plain'));
  t('挑出 alpha-vl-1', chs.some((c) => c.model === 'alpha-vl-1'));
  t('挑出 beta-vision', chs.some((c) => c.model === 'beta-vision'));
  t('无凭据的 provider 被跳过', !chs.some((c) => c.provider === 'p-nokey'));
  t('chain 顺序优先（beta 在前）', chs[0].provider === 'p-beta');
  t('来源标记 dsh', chs.every((c) => c.source === 'dsh'));

  // ★ 关键：靠 input 声明识别（名字里没有 vl/vision 也算）
  t('声明了 image 输入就视为可看图（与名字无关）', chs.some((c) => c.model === 'gamma-plain-name'));
  t('只声明 text 的模型不算视觉', !chs.some((c) => c.model === 'gamma-text-only'));

  // 指定 model 时按它取（仍是视觉才拿）
  const forced = await resolveDshVisionChannels({ model: 'beta-vision' }, routes);
  t('指定 model → 只返回它', forced.length >= 1 && forced.every((c) => c.model === 'beta-vision'));

  // 白名单可以救回"既没声明也没能力词"的模型
  const wl = await resolveDshVisionChannels({ visionModels: ['alpha-plain'] }, routes);
  t('白名单让普通模型也算视觉', wl.some((c) => c.model === 'alpha-plain'));

  const none = await resolveDshVisionChannels({}, { providers: {}, chain: [], creds: {}, hasPatch: false });
  t('没有 patch → 空列表', none.length === 0);
}

section('视觉能力判定（声明优先）');
{
  t('声明 image → 可看图', supportsImageInput({ id: 'whatever', input: ['text', 'image'] }));
  t('只声明 text → 不可', supportsImageInput({ id: 'whatever', input: ['text'] }) === false);
  t('多个能力里含 image 即可', supportsImageInput({ id: 'x', input: ['text', 'audio', 'image'] }));
  t('无声明时按名字兜底（vl）', supportsImageInput({ id: 'some-vl-1' }));
  t('无声明 + 名字无能力词 → 不可', supportsImageInput({ id: 'plain-model' }) === false);
  t('白名单一票通过', supportsImageInput({ id: 'plain-model', input: ['text'] }, { visionModels: ['plain-model'] }));
  t('字符串入参也能判', supportsImageInput('qwen-vl-max'));
}

section('渠道解析 · 优先级（注入 > 自备KEY > DSH）');
{
  const injected = await resolveVision({ chatVision: () => ({ ok: true, text: 'x' }) });
  t('注入优先，source=injected', injected.source === 'injected');

  const noKey = await resolveVision({ env: {}, reuseDsh: false });
  t('无注入无 KEY 且不复用 DSH → null', noKey === null);

  const ownOnly = await resolveVision({ env: { IR_VISION_API_KEY: 'k', IR_VISION_BASE_URL: 'http://x/v1', IR_VISION_MODEL: 'm' }, reuseDsh: false });
  t('自备 KEY → source=env', ownOnly.source === 'env');

  // 自备 KEY 存在时，即便复用 DSH 也排在前面
  const chs = await resolveVisionChannels({ env: { IR_VISION_API_KEY: 'k', IR_VISION_BASE_URL: 'http://x/v1', IR_VISION_MODEL: 'm' } });
  t('自备 KEY 排在 DSH 渠道之前', chs[0].source === 'env');
  t('渠道列表里 DSH 排在后面（若有）', chs.slice(1).every((c) => c.source === 'dsh'));
}

section('多模态拼装与调用');
{
  const oa = toApiContent([{ type: 'text', text: '看图' }, { type: 'image', base64: 'QUJD', mediaType: 'image/png' }], 'openai-completions');
  t('openai：image → image_url data URI', oa[1].type === 'image_url' && oa[1].image_url.url.startsWith('data:image/png;base64,'));
  const an = toApiContent([{ type: 'image', base64: 'QUJD', mediaType: 'image/png' }], 'anthropic-messages');
  t('anthropic：image → base64 source', an[0].source.type === 'base64' && an[0].source.media_type === 'image/png');
  t('string content 原样', toApiContent('纯文本', 'openai-completions') === '纯文本');

  // callOnce 两种风格（mock fetch）
  mockFetch((url) => {
    if (url.endsWith('/chat/completions')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'openai 回复' } }] }) };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ content: [{ thinking: '想想', signature: 's' }, { text: 'anthropic 正文' }] }),
    };
  });
  const r1 = await callOnce(
    { api: 'openai-completions', baseURL: 'http://x/v1', apiKey: 'k', model: 'm', maxTokens: 100 },
    { system: 's', messages: [{ role: 'user', content: 'hi' }] }
  );
  t('openai 风格取到正文', r1.ok && r1.text === 'openai 回复');
  const r2 = await callOnce(
    { api: 'anthropic-messages', baseURL: 'http://y', apiKey: 'k', model: 'm', maxTokens: 100 },
    { system: 's', messages: [{ role: 'user', content: 'hi' }] }
  );
  t('anthropic 风格跳过 thinking 取正文', r2.ok && r2.text === 'anthropic 正文');
  t('anthropic 请求带 x-api-key', calls.some((c) => c.url.endsWith('/v1/messages') && c.opts.headers['x-api-key'] === 'k'));
  t('openai 请求带 Bearer', calls.some((c) => c.url.endsWith('/chat/completions') && c.opts.headers.authorization === 'Bearer k'));
  restoreFetch();

  // 失败时按顺序尝试下一条渠道
  mockFetch((url) => ({ ok: false, status: 500, text: async () => 'boom' }));
  const r3 = await callOnce({ api: 'openai-completions', baseURL: 'http://x/v1', apiKey: 'k', model: 'm' }, { system: 's', messages: [] });
  restoreFetch();
  t('失败返回 ok:false + status', r3.ok === false && r3.status === 500);
}

// ═══════════════ 11. recognize() 编排 ═══════════════
section('recognize 编排');
{
  // 参数校验
  const bad1 = await recognize({ images: [] });
  t('缺 task → ok:false', bad1.ok === false && String(bad1.error).includes('task'));
  const bad2 = await recognize({ task: 'text', images: [] });
  t('缺 images → ok:false', bad2.ok === false);

  // 单一任务：text（OCR mock）
  mockFetch((url) => {
    if (url.endsWith('/health')) return jsonRes({ ok: true });
    if (url.endsWith('/ocr')) return jsonRes({ ok: true, text: '网络连接失败\n错误码 10086', boxes: [{ text: 'a', conf: 0.97 }] });
    return imgRes();
  });
  const r1 = await recognize({
    task: 'text',
    images: ['https://img/x.jpg'],
    options: { ocr: { server: 'http://127.0.0.1:8791' }, prefilter: { vlmBinary: false }, vision: { enabled: false } },
  });
  restoreFetch();
  t('text ok', r1.ok === true && r1.task === 'text');
  t('拿到文字', r1.results[0].text.includes('10086'));
  t('带标签', r1.results[0].labels.includes('含数字'));
  t('method=ocr', r1.results[0].method === 'ocr');
  t('meta.methods 含 ocr', r1.meta.methods.includes('ocr'));
  t('meta.images 有条目', r1.meta.images.length === 1);

  // 组合任务
  mockFetch((url) => {
    if (url.endsWith('/ocr')) return jsonRes({ ok: true, text: '测试文字123', boxes: [] });
    if (url.endsWith('/match')) return jsonRes({ ok: true, matches: [{ id: 'd', name: '钻石', score: 0.9 }] });
    if (url.includes('/chat/completions')) return openaiRes('图里有钻石和一个植物');
    return imgRes();
  });
  const r2 = await recognize({
    tasks: ['text', 'feature'],
    images: ['https://img/y.jpg'],
    hint: '识别文字与特征',
    templates: [{ id: 'd', name: '钻石', image: 'QUJD', threshold: 0.8 }],
    options: {
      ocr: { server: 'http://127.0.0.1:8791' },
      features: { server: 'http://127.0.0.1:8791' },
      prefilter: { vlmBinary: false },
      vision: { enabled: false },
    },
  });
  restoreFetch();
  t('组合 ok', r2.ok === true && Array.isArray(r2.tasks));
  t('results 按任务分组', r2.results.text && r2.results.feature);
  t('text 有结果', r2.results.text[0].text.includes('123'));
  t('feature 有模板命中', r2.results.feature[0].features.some((f) => f.name === '钻石'));
  t('组合只下载一次图', r2.meta.images.length === 1);

  // 降级：无 VLM 渠道 → 不抛错
  //   注意 mock 必须同时能应图片下载与 /ocr，否则图在预筛就被挡掉、任务根本不跑
  mockFetch((url) => (url.endsWith('/ocr') ? jsonRes({ ok: true, text: '', boxes: [] }) : imgRes()));
  const r3 = await recognize({
    task: 'text',
    images: ['https://img/z.jpg'],
    options: { ocr: { server: 'http://127.0.0.1:8791' }, prefilter: { vlmBinary: false }, vision: { enabled: true, env: {}, reuseDsh: false } },
  });
  restoreFetch();
  t('无渠道降级不抛错', r3.ok === true);
  t('degraded 含 vlm 说明', r3.meta.degraded.some((d) => d.startsWith('vlm') || d.startsWith('text-vlm')), JSON.stringify(r3.meta.degraded));

  // 预筛挡掉
  const r4 = await recognize({
    task: 'text',
    images: ['data:image/png;base64,' + 'A'.repeat(10)],
    options: { prefilter: { quality: true, vlmBinary: false }, vision: { enabled: false } },
  });
  t('过小图被预筛挡下', r4.meta.skipped.some((s) => s.reason === 'too-small'));
  t('全被挡则结果空', r4.results.length === 0);

  // match 任务（注入渠道）
  mockFetch((url) => (url.includes('/chat/completions') ? openaiRes('{"matches":[{"intent":"error","confidence":0.91,"reason":"红框"}]}') : imgRes()));
  const r5 = await recognize({
    task: 'match',
    images: ['https://img/m.jpg'],
    intents: [
      { id: 'error', label: '错误弹窗' },
      { id: 'activity', label: '活动页' },
    ],
    options: {
      prefilter: { vlmBinary: false },
      vision: { chatVision: (cfg, opts) => {
        // 走内置 mock fetch 路径：直接返回固定 JSON（模拟模型）
        return Promise.resolve({ ok: true, text: '{"matches":[{"intent":"error","confidence":0.91,"reason":"红框"}]}' });
      } },
    },
  });
  restoreFetch();
  t('match 返回两条（含补零）', r5.results.length === 2);
  t('match 最高分是 error', r5.results[0].intent === 'error' && r5.results[0].confidence === 0.91);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);