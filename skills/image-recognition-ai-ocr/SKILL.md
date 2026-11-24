---
name: image-recognition-ai-ocr
description: image-recognition-ai-ocr 仅做图片识别，拿到图片，返回文字。配图识别（取图 → OCR/VLM/模板匹配 → 文字回灌），输出结构化 JSON（文字 / 标签 / 置信度 / 特征 / 分类 / 降级说明），业务判断归下游。三类任务：①match 判断图片是否匹配某意图（返回置信度）②text 读出图里的文字 ③feature 认非文字特征。图片、任务、资料均由使用者提供（用户或其它 AI/skill 均可），本 skill 按任务给结果，并带自己的通用资料层与免费预筛。当需要把图片（截图 / 海报 / 表格 / 文档照片 / 游戏画面）转成可判断的文字与标签，或让 AI 先「看懂图」再决策时使用。
---

# image-recognition-ai-ocr

> 给它图片和任务，它给你结构化结果 —— **不做业务判断，也不替你决定**。

## 三类任务

| 任务 | 你给什么 | 它回什么 |
|---|---|---|
| `match` **判断** | 意图 A/B/C + 图片 1/2/3 | 每张图对每个意图的**置信度** + 依据 |
| `text` **读字** | 图片 A | 图 A 的文字 + 标签 + 逐行置信度 |
| `feature` **认特征** | 图片 + 任务说明（+ 模板库） | 特征列表 + 整体描述 |

一次可跑多个任务（`tasks: ['text','feature']`），共享取图/下载/缓存。

## 最小示例

```js
import { recognize } from './scripts/index.mjs';

// 判断：这两张图分别是哪种场景？
const r = await recognize({
  task: 'match',
  images: ['https://x/a.jpg', 'https://x/b.jpg'],
  intents: [
    { id: 'error_dialog',  label: '错误弹窗' },
    { id: 'activity_page', label: '活动页面' },
  ],
});
for (const m of r.results) console.log(m.image, m.label, m.confidence, m.reason);
```

```js
// 读字
const r = await recognize({ task: 'text', images: ['https://x/a.jpg'] });
console.log(r.results[0].text, r.results[0].labels);

// 认特征（模板库由调用方传）
const r2 = await recognize({
  task: 'feature',
  images: ['https://x/a.jpg'],
  hint: '识别图中的植物名称与奖励物品',
  templates: [{ id: 'diamond', name: '钻石', image: '<base64>', threshold: 0.85 }],
});
```

## 输出外壳

```json
{ "ok": true, "task": "text", "results": [ ... ], "meta": { ... } }
```

组合任务时 `results` 变成按任务分组：`{ "text": [...], "feature": [...] }`。

`meta` 里带 `images` / `methods` / `degraded`（哪条通道没跑成）/ `skipped`（哪张图被预筛挡下）/ `ms`。
**一切识别失败降级不抛错**，`ok:false` 只在参数非法时出现。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/overview.md](docs/overview.md) | 介绍：它做什么 / 不做什么 / 为什么这么设计 / 资料层理念 |
| [docs/install.md](docs/install.md) | 安装、依赖清单、本地服务启动、看图渠道配置、排障 |
| [docs/api.md](docs/api.md) | 完整输入输出契约（给下游对接用） |

## 文件

```
scripts/index.mjs        入口 recognize()
scripts/tasks/           match.mjs / text.mjs / feature.mjs
scripts/image.mjs        取图与规范化
scripts/prefilter.mjs    质量预筛 + VLM 二分类
scripts/ocr.mjs          OCR 通道
scripts/vision.mjs       VLM 通道
scripts/features.mjs     模板匹配通道
scripts/materials.mjs    资料层（内置 + 调用方 + 积累）
scripts/cache.mjs        结果缓存
scripts/server.py        本地图像服务（/health /ocr /match）
test/test-all.mjs        自测（离线，node test/test-all.mjs）
```