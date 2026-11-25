# 输入输出契约 · image-recognition-ai-ocr

> 给下游对接用。字段一旦发布即视为契定，改字段会同步改这份文档。

---

## 1. 入口

```js
import { recognize } from './scripts/index.mjs';
const result = await recognize(input);
```

`recognize` **永不抛错**（网络/服务/模型问题一律降级），只有参数非法时返回 `ok: false`。

### 1.1 auto 模式（不传 `task`）

调用方通常判断不出「这是截图还是画面」，所以默认交给本 skill 分流，**每张图只做该做的事**：

```
质量预筛（免费）
  → OCR（免费，本地 ≈1.9s/图）
    → 按文字量分流：
        字数 ≥ richTextChars(默认 20)  → 文字图：出 text（全量原文，不截断）
        字数 <  richTextChars          → 画面图：出 feature 描述（默认 ≤200 字）
  → 调用方给了 intents → 再补一次 match（只为判断，不读字、不描述）
```

要点：

- auto 下**不跑 VLM 二分类预筛**（OCR 文字量已经承担了「图里有没有内容」的判断），每图少一次模型调用
- auto 只挑**一类**内容任务：文字图不描述、画面图不读字；需要两者都要时显式传 `tasks: ['text','feature']`
- 想强制某一种任务就显式传 `task`，**显式优先，内部规则不介入**

---

## 2. 输入

### 2.1 顶层字段

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `task` | string \| string[] | 否 | `'match'` / `'text'` / `'feature'`；**留空 = auto**（本 skill 按图片内容自行判断，见 §1.1） |
| `tasks` | string[] | 否 | 组合任务，等价于 `task` 传数组 |
| `images` | array | **必需** | 图片：URL / base64 / dataURI / 对象 |
| `extractor` | function | 否 | `(obj) => url[]`，从你的对象里取图 |
| `intents` | array | `match` 必需 | `[{id, label, description}]`；auto 下给了就顺带跑判断 |
| `onlyBest` | boolean | 否 | `match` 只返回最高分，默认 `false` |
| `hint` | string | 否 | 任务说明（`text` 兜底读字 / `feature` 必填更佳） |
| `templates` | array | 否 | `feature` 的模板库 `[{id,name,image,threshold}]` |
| `maxDescChars` | number | 否 | `feature` 描述**输出长度**（字符）。默认 **200**；传 `0` = 不限；传 `null`/空 = 用默认 |
| `context` | string | 否 | 一句话背景资料 |
| `materials` | array \| object | 否 | 补充资料，见 §2.3 |
| `prompt` | string | 否 | 覆盖内置任务提示词（少用） |
| `options` | object | 否 | 通道与运行参数，见 §2.2 |

### 2.2 options

| 字段 | 默认 | 说明 |
|---|---|---|
| `prefilter.quality` | `true` | 免费质量预筛（无图/过小/重复） |
| `prefilter.vlmBinary` | `true` | VLM 二分类「这图有信息吗」。**auto 与纯 `match` 一律跳过**（与"每图时间最短"冲突，省一次调用）；显式 `text`/`feature` 才按此配置跑 |
| `ocr.enabled` | `true` | OCR 通道开关 |
| `ocr.server` | `http://127.0.0.1:8791` | 本地服务地址 |
| `ocr.timeoutMs` | `30000` | |
| `features.enabled` | `true` | 模板匹配通道开关 |
| `features.server` | `http://127.0.0.1:8791` | |
| `vision.enabled` | `true` | VLM 通道开关 |
| `vision.chatVision` | — | 注入看图函数（见 install.md §4） |
| `vision.model` | — | 仅用于标注来源 |
| `visionFallback` | `true` | `text` 任务 OCR 空时是否用 VLM 兜底 |
| `vision.preferUrl` | `true` | **优先把公网 URL 交给模型**（本地零上传）；无 URL 才回落到 base64 |
| `vision.shrink` | `true` | 走 base64 时先用本地 `/resize` 缩图（长边默认 1024） |
| `vision.shrinkMaxSide` | `1024` | 缩图长边上限 |
| `vision.shrinkServer` | `http://127.0.0.1:8791` | 缩图用的本地服务 |
| `vision.maxChannelTries` | `4` | 单次调用最多试几条渠道（别把 11 条全轮一遍） |
| `vision.channelCooldownMs` | `600000` | 失败渠道冷却多久（期间不重试，避免反复传大图） |
| `vision.debug` | `false` | 打印每条渠道的尝试与耗时 |
| `featureVisionForRichText` | `false` | 显式 `text`+`feature` 时，**文字已读够的图是否仍让 VLM 描述**（默认跳过，省几十秒） |
| `richTextChars` | `20` | auto 分流阈值，以及上面那条判定共用的字数门槛 |
| `cache` | 内存 | 自己的缓存对象（`{get,set}`） |
| `cacheFile` | — | 落盘缓存路径（会调 `save()`） |
| `cacheTtlHours` | `168` | |
| `learnedMaterialsFile` | — | 积累资料文件路径 |
| `builtinMaterials` | `true` | 是否带内置资料 |
| `maxImages` | `20` | 单次最多处理几张图（超出截断并写 `meta.truncated`） |
| `downloadTimeoutMs` | `30000` | 图片下载超时 |
| `log` | — | `(msg) => void` 日志回调 |

### 2.3 images 的四种形态

```js
// ① URL
['https://x/a.jpg']

// ② base64（裸串）
['iVBORw0KGgo...']

// ③ data URI
['data:image/png;base64,iVBORw0KGgo...']

// ④ 你自己的对象（配合 extractor）
[{ attachments: [{ url: 'https://x/a.jpg' }] }]
//   → recognize({ images: [obj], extractor: (p) => p.attachments.map(a => a.url) })
```

不传 `extractor` 时用**通用抽取**：认 `url` / `src` / `image` / `imageUrl` / `original_url` / `cover`
以及 `images` / `pics` / `photos` / `footer_images` / `attachments` 这些数组字段。

---

## 3. 输出

### 3.1 外壳

```json
{ "ok": true, "mode": "auto", "results": [ ... ], "meta": { ... } }
```

- `mode`：`auto`（没传 task）/ `explicit`（传了 task）
- `results`：**永远是数组，一图一条**（2026-11-25 起）。组合任务也不再按任务分组 ——
  auto 下每张图跑的任务可能不同，分组本身不成立。
- 兼容字段：显式单任务仍带 `task`，显式多任务仍带 `tasks`；读结果统一读 `results`。

### 3.2 结果行（一图一条）

```json
{ "image": "img1", "url": "https://x/a.jpg",
  "tasks": ["text"],
  "text": "网络连接失败\n错误码 10086", "chars": 16,
  "lines": [{ "text": "网络连接失败", "score": 0.97 }],
  "labels": ["含中文", "含数字", "错误提示"],
  "matches": null, "features": [], "description": "",
  "method": "ocr" }
```

| 字段 | 说明 |
|---|---|
| `image` / `url` | 图 ref 与来源地址 |
| `tasks` | 这张图**真正产出了内容**的任务；空数组 = 没产出（被预筛挡下或没通道） |
| `text` | `text` 任务：**全量原文**，不截断、不限行数 |
| `chars` | `text` 的字数（下游关注文本量时不用自己数） |
| `lines` | 逐行文字与置信度 |
| `labels` | 通用标签，见 §3.4 |
| `matches` | `match` 任务：`[{intent,label,confidence,reason,missing?}]`，按置信度降序；没跑就是 `null` |
| `features` | `feature` 任务：模板命中 |
| `description` | `feature` 任务：模型描述（长度受 `maxDescChars` 控制） |
| `method` | 实际用到的通道：`ocr` / `vlm` / `template`，可组合成 `ocr+vlm`、`template+vlm` |
| `skipped` | 被预筛挡下时的原因；有它时 `tasks` 必为空 |

### 3.3 `meta`

| 字段 | 类型 | 说明 |
|---|---|---|
| `mode` | string | `auto` / `explicit` |
| `images` | array | `[{ref, url, format, bytes, error?}]`，`ref` 形如 `img1` |
| `tasks` | string[] | 本次执行的任务（auto 下是各行 `tasks` 的并集） |
| `methods` | string[] | 实际用到的通道：`template` / `ocr` / `vlm` |
| `degraded` | string[] | 降级说明，格式 `<通道>:<ref>:<原因>` 或 `<通道>:<原因>` |
| `skipped` | array | `[{ref, reason}]`，被预筛挡下的图 |
| `materials` | number | 合并到的资料条数 |
| `truncated` | number | 超过 `maxImages` 被截掉的张数（仅在有截断时出现） |
| `ms` | number | 总耗时 |

`skipped.reason` 取值：`too-small` / `too-few-pixels` / `duplicate` / `no-data` / `download:<err>` / `no-info`。

`degraded` 常见取值：

- `vlm:no-channel` — 没配看图渠道
- `ocr:<ref>:HTTP 500` — OCR 服务异常
- `template:no-templates` — 没传模板
- `feature:no-channel` — 特征任务三通道全不可用
- `match:<ref>:unparsable` — 模型没按 JSON 回
- `match:no-intents` — 没传 intents

### 3.4 `match` 的字段

```json
"matches": [
  { "intent": "error_dialog", "label": "错误弹窗",
    "confidence": 0.93, "reason": "画面中央红框提示" }
]
```

| 字段 | 说明 |
|---|---|
| `intent` | 意图 id（与输入 `intents[].id` 对应） |
| `label` | 意图标签 |
| `confidence` | `0~1`，已归一（`92` → `0.92`） |
| `reason` | 判定依据，**一句话 ≤20 字**（判定任务不做描述，写长了纯浪费） |
| `missing` | `true` 表示模型漏答、此处补 `confidence: 0` |

**排序**：按 `confidence` 降序。`onlyBest: true` 时每图只留第一条。

### 3.5 `text` 的字段

```json
"text": "网络连接失败\n错误码 10086",
"chars": 16,
"lines": [{ "text": "网络连接失败", "score": 0.97 }],
"labels": ["含中文", "含数字", "错误提示"],
"method": "ocr"
```

**文本量不受限**：OCR 原文全量返回（服务端不截断、客户端不 trim 中间、不限行数/字数）；
OCR 读空时才用 VLM 兜底，兜底预算 4000 token，提示词明令「有多少读多少，禁止概括/省略」。

`labels` 取值（通用派生，不含业务知识）：`含中文` `含英文` `含数字` `错误提示` `含链接` `含时间` `含奖励` `多行文本` `长文本`。

`method`：`ocr` / `vlm` / `none`。

### 3.6 `feature` 的字段

```json
"features": [{ "id": "diamond", "name": "钻石", "method": "template", "score": 0.91 }],
"description": "画面展示一张植物卡片：瓷砖萝卜；右下角有钻石图标 ×334。",
"method": "template+vlm"
```

`description` 长度由 `maxDescChars` 控制：默认 200 字、传 `0` = 不限、传 `null`/空 = 用默认。
提示词里写「总长度控制在 N 字以内」，并按字数换算输出预算。

`method`：`template` / `vlm` / `template+vlm` / `none`。

---

## 4. 语义保证

| 保证 | 说明 |
|---|---|
| 不抛错 | 网络/服务/模型失败一律进 `degraded` |
| 不静默 | 被跳过、被降级的都有记录 |
| 幂等 | 同图同任务同参数 → 命中缓存，结果一致 |
| 不漏报 | 模型漏答的意图补 `confidence: 0, missing: true` |
| 不丢图 | 每张输入图都有一条结果行（被预筛挡下的带 `skipped` 原因） |
| 参数错才 `ok:false` | 只缺 `images` / 未知任务类型 |
| 组合共享下载 | `tasks:['text','feature']` 只下载一次图 |
| 判定最省 | 纯 `match` 不跑 VLM 二分类、不读字、不描述，每图仅 1 次模型调用 |

---

## 5. 导出的其它函数

除 `recognize` 外，以下也公开（便于精细控制或单测）：

| 函数 | 用途 |
|---|---|
| `normalizeTasks({task,tasks})` | 任务归一化 |
| `normalizeImages(images, opts)` | 取图与规范化 |
| `loadCache(file, {ttlHours})` / `memoryCache()` | 缓存 |
| `cacheKey(kind, ref, sig)` | 生成缓存键 |
| `loadMaterials(opts)` / `formatMaterials(mats)` / `learnMaterial(file, item)` | 资料层 |
| `resolveVision(config)` / `describeImages(images, opts)` | 看图渠道 |
| `ocrHealth(config)` / `ocrImage(img, opts)` / `ocrImages(imgs, opts)` | OCR |
| `matchImage(img, templates, opts)` / `matchImages(...)` | 模板匹配 |
| `prefilter(images, opts)` / `qualityPrefilter(...)` / `vlmBinaryPrefilter(...)` / `parseBinaryAnswer(text)` | 预筛 |
| `tryParseJson(text)` / `toConfidence(v)` / `salvageJsonObjects(text)` | 模型输出解析（后者用于抢救被截断的 JSON） |
| `deriveLabels(text)` | 文字标签派生 |
| `buildMatchPrompt(intents, opts)` / `normalizeMatchResult(parsed, intents, opts)` / `matchMaxTokens(n)` | `match` 细节 |
| `buildFeaturePrompt(hint, opts)` / `tokensForChars(n)` / `DEFAULT_MAX_DESC_CHARS` | `feature` 细节 |
| `TASKS` / `AUTO` / `AUTO_RICH_CHARS` | `['match','text','feature']` / `'auto'` / `20` |