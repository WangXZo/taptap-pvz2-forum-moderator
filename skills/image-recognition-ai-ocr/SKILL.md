---
name: image-recognition-ai-ocr
description: image-recognition-ai-ocr 仅做图片识别，拿到图片，返回文字。配图识别（取图 → OCR/VLM/模板匹配 → 文字回灌），输出结构化 JSON（文字 / 标签 / 置信度 / 特征 / 分类 / 降级说明），业务判断归下游。三类任务：①match 判断图片是否匹配某意图（返回置信度，一句话）②text 读出图里的文字（全量不限字）③feature 认非文字特征（描述长度可限，默认 200 字）。不传任务即 auto：按图片内容自行判断该读字还是该描述。图片、资料由使用者提供，本 skill 按任务给结果，并带自己的通用资料层与免费预筛。当需要把图片（截图 / 海报 / 表格 / 文档照片 / 游戏画面）转成可判断的文字与标签，或让 AI 先「看懂图」再决策时使用。
---

# image-recognition-ai-ocr

> 给它图片，它给你结构化结果 —— **不做业务判断，也不替你决定任务类型**。

## 三类任务

| 任务 | 你给什么 | 它回什么 | 耗时 |
|---|---|---|---|
| `match` **判断** | 意图清单 + 图片 | 每意图的**置信度** + 一句话依据（≤20 字） | **最短**，≈3s/图 |
| `text` **读字** | 图片 | **全量文字**（不限字数）+ 标签 + 字数 | 中等，≈2s/图 |
| `feature` **认特征** | 图片 + 任务说明（+ 模板库） | 特征列表 + 描述（默认 ≤200 字，`maxDescChars: 0` = 不限） | ≈5~8s/图 |

不传任务 = **auto**：先 OCR（免费），文字够（≥20 字）就当文字图出 `text`，文字不够就当画面图出 `feature` 描述；
你给了 `intents` 就再补一次 `match`。想强制某一种就显式传 `task`。

## 最小示例

```js
import { recognize } from './scripts/index.mjs';

// auto：只管给图，它自己判断该读字还是该描述
const r = await recognize({ images: ['https://x/a.jpg', 'https://x/b.jpg'] });
for (const row of r.results) console.log(row.image, row.tasks, row.text, row.description);
```

```js
// 判断两张图分别是哪种场景（只要判断，不读字、不描述）
const r = await recognize({
  task: 'match',
  images: ['https://x/a.jpg', 'https://x/b.jpg'],
  intents: [
    { id: 'error_dialog',  label: '错误弹窗' },
    { id: 'activity_page', label: '活动页面' },
  ],
});
for (const row of r.results) console.log(row.image, row.matches[0].label, row.matches[0].confidence);
```

```js
// 认特征（模板库与任务说明由调用方传；描述长度可控）
const r2 = await recognize({
  task: 'feature',
  images: ['https://x/a.jpg'],
  hint: '识别图中的植物名称与奖励物品',
  templates: [{ id: 'diamond', name: '钻石', image: '<base64>', threshold: 0.85 }],
  maxDescChars: 120,   // 0 = 不限；不传 = 200
});
```

## 输出外壳

```json
{ "ok": true, "mode": "auto",
  "results": [ { "image": "img1", "tasks": ["text"], "text": "...", "chars": 214,
                 "labels": ["含中文"], "matches": null, "features": [], "description": "" } ],
  "meta": { "methods": [], "degraded": [], "skipped": [], "ms": 0 } }
```

`results` **永远是数组、一图一条**（组合任务也不分组）。没跑的任务字段是 `null` / 空，不存在的块。
`meta` 里带 `mode` / `images` / `methods` / `degraded`（哪条通道没跑成）/ `skipped`（哪张图被预筛挡下）/ `ms`。
**一切识别失败降级不抛错**，`ok:false` 只在参数非法时出现。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/overview.md](docs/overview.md) | 介绍：它做什么 / 不做什么 / auto 分流 / 资料层理念 |
| [docs/install.md](docs/install.md) | 安装、依赖清单、本地服务启动、看图渠道配置、排障 |
| [docs/api.md](docs/api.md) | 完整输入输出契约（给下游对接用） |

独立仓库：<https://github.com/WangXZo/image-recognition-ai-ocr>（`git clone` 即可安装）

## 文件

```
scripts/index.mjs        入口 recognize()（含 auto 分流）
scripts/tasks/           match.mjs / text.mjs / feature.mjs
scripts/image.mjs        取图与规范化
scripts/prefilter.mjs    质量预筛 + VLM 二分类（后者 auto/纯判断跳过）
scripts/ocr.mjs          OCR 通道
scripts/vision.mjs       VLM 通道
scripts/features.mjs     模板匹配通道
scripts/materials.mjs    资料层（内置 + 调用方 + 积累）
scripts/cache.mjs        结果缓存
scripts/server.py        本地图像服务（/health /ocr /match /resize）
test/test-all.mjs        自测（离线，node test/test-all.mjs）
```