# 输入输出契约 · image-recognition-ai-ocr

> 给下游对接用。字段一旦发布即视为契定，改字段会同步改这份文档。

---

## 1. 入口

```js
import { recognize } from './scripts/index.mjs';
const result = await recognize(input);
```

`recognize` **永不抛错**（网络/服务/模型问题一律降级），只有参数非法时返回 `ok: false`。

---

## 2. 输入

### 2.1 顶层字段

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `task` | string \| string[] | 二选一 | `'match'` / `'text'` / `'feature'` |
| `tasks` | string[] | 二选一 | 组合任务，等价于 `task` 传数组 |
| `images` | array | **必需** | 图片：URL / base64 / dataURI / 对象 |
| `extractor` | function | 否 | `(obj) => url[]`，从你的对象里取图 |
| `intents` | array | `match` 必需 | `[{id, label, description}]` |
| `onlyBest` | boolean | 否 | `match` 只返回最高分，默认 `false` |
| `hint` | string | 否 | 任务说明（`text` 兜底读字 / `feature` 必填更佳） |
| `templates` | array | 否 | `feature` 的模板库 `[{id,name,image,threshold}]` |
| `context` | string | 否 | 一句话背景资料 |
| `materials` | array \| object | 否 | 补充资料，见 §2.3 |
| `prompt` | string | 否 | 覆盖内置任务提示词（少用） |
| `options` | object | 否 | 通道与运行参数，见 §2.2 |

### 2.2 options

| 字段 | 默认 | 说明 |
|---|---|---|
| `prefilter.quality` | `true` | 免费质量预筛（无图/过小/重复） |
| `prefilter.vlmBinary` | `true` | VLM 二分类「这图有信息吗」 |
| `ocr.enabled` | `true` | OCR 通道开关 |
| `ocr.server` | `http://127.0.0.1:8791` | 本地服务地址 |
| `ocr.timeoutMs` | `30000` | |
| `features.enabled` | `true` | 模板匹配通道开关 |
| `features.server` | `http://127.0.0.1:8791` | |
| `vision.enabled` | `true` | VLM 通道开关 |
| `vision.chatVision` | — | 注入看图函数（见 install.md §4） |
| `vision.model` | — | 仅用于标注来源 |
| `visionFallback` | `true` | `text` 任务 OCR 空时是否用 VLM 兜底 |
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

**单一任务**

```json
{ "ok": true, "task": "text", "results": [ ... ], "meta": { ... } }
```

**组合任务**

```json
{ "ok": true, "tasks": ["text","feature"],
  "results": { "text": [ ... ], "feature": [ ... ] },
  "meta": { ... } }
```

### 3.2 `meta`

| 字段 | 类型 | 说明 |
|---|---|---|
| `images` | array | `[{ref, url, format, bytes, error?}]`，`ref` 形如 `img1` |
| `tasks` | string[] | 本次执行的任务 |
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

### 3.3 `match` 的结果项

```json
{ "image": "img1", "intent": "error_dialog", "label": "错误弹窗",
  "confidence": 0.93, "reason": "画面中央有红框提示与错误码 10086" }
```

| 字段 | 说明 |
|---|---|
| `image` | 图 ref |
| `intent` | 意图 id（与输入 `intents[].id` 对应） |
| `label` | 意图标签 |
| `confidence` | `0~1`，已归一（`92` → `0.92`） |
| `reason` | 判定依据 |
| `missing` | `true` 表示模型漏答、此处补 `confidence: 0` |

**排序**：按 `confidence` 降序。`onlyBest: true` 时每图只留第一条。

### 3.4 `text` 的结果项

```json
{ "image": "img1",
  "text": "网络连接失败\n错误码 10086",
  "lines": [{ "text": "网络连接失败", "score": 0.97 }],
  "labels": ["含中文", "含数字", "错误提示"],
  "method": "ocr" }
```

`labels` 取值（通用派生，不含业务知识）：`含中文` `含英文` `含数字` `错误提示` `含链接` `含时间` `含奖励` `多行文本` `长文本`。

`method`：`ocr` / `vlm` / `none`。

### 3.5 `feature` 的结果项

```json
{ "image": "img1",
  "features": [{ "id": "diamond", "name": "钻石", "method": "template", "score": 0.91 }],
  "description": "画面展示一张植物卡片：瓷砖萝卜；右下角有钻石图标 ×334。",
  "method": "template+vlm" }
```

`method`：`template` / `vlm` / `template+vlm` / `none`。

---

## 4. 语义保证

| 保证 | 说明 |
|---|---|
| 不抛错 | 网络/服务/模型失败一律进 `degraded` |
| 不静默 | 被跳过、被降级的都有记录 |
| 幂等 | 同图同任务同参数 → 命中缓存，结果一致 |
| 不漏报 | 模型漏答的意图补 `confidence: 0, missing: true` |
| 参数错才 `ok:false` | 只缺 `task` / `images` / 未知任务类型 |
| 组合共享下载 | `tasks:['text','feature']` 只下载一次图 |

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
| `tryParseJson(text)` / `toConfidence(v)` | 模型输出解析 |
| `deriveLabels(text)` | 文字标签派生 |
| `buildMatchPrompt(intents, opts)` / `normalizeMatchResult(parsed, intents, opts)` | `match` 细节 |
| `buildFeaturePrompt(hint)` | `feature` 提示词 |
| `TASKS` | `['match','text','feature']` |