---
name: pvz2-image-recognition
description: 论坛帖子配图识别（取图 → 门控 → OCR/VLM/模板匹配 → 文字回灌）：把游戏截图里的文字、活动奖励、错误弹窗、植物名称读出来，并入帖子正文供答疑检索使用。三种手段——本地模板匹配（免费离线）、RapidOCR 本地 OCR（免费离线）、VLM 看图（跟随调用方的多模态渠道）。带意图与相关性门控，求码/加好友帖直接跳过，装饰性配图不浪费识别成本。识别失败一律降级不抛错。当需要读懂论坛帖子里配图的内容、或给任何脚本加「看图出文字」能力时使用。
---

# 论坛配图识别（PVZ2）

> 定位：给任何脚本一个**「帖子配图 → 文字」**的识别能力。
> 一句话：**把图里能读的东西读出来，并进帖子正文**，下游的答疑检索、联网搜索、LLM 组答自动受益。

## 它解决什么问题

论坛里很多答案在**图里**而不是文字里：

- 活动奖励截图（「这是啥活动，奖什么」）
- 报错弹窗（「这啥意思，报错码多少」）
- 植物图鉴（「这植物什么技能」）
- 十连出货截图（「这出货是什么稀有货」）

没有这一步，答疑只能回「看不清图片，麻烦描述一下」—— 玩家体验差。

## 三条规则（门控，别浪费钱）

识别不是「见图就识」，那会烧钱且没意义：

1. **码/好友意图 → 直接跳过**
   帖子里在求天宫码 / 要加好友的，配图多半是码，跟问题无关，不读。
2. **相关性门控 → 无关配图跳过**
   正文已经又长又清楚（分享日记），配图大概率是装饰，不读。
   正文短、或像在求助 → 读。
3. **识别内容并入帖子文本**
   读出来的东西以 `[图片内容] …` 追加到正文，下游自动受益。

## 三种识别手段

| 手段 | 实现 | 适合 | 成本 |
|---|---|---|---|
| **S6 模板匹配** | `scripts/features.mjs` + `assets/game-features/` | 已知植物/奖励图标/UI（钻石、瓷砖萝卜、自选道具…） | 免费离线、ms 级 |
| **S3 OCR** | `scripts/ocr.mjs` → `POST /ocr` | 错误文案、数字、活动规则、图鉴说明文本 | 免费离线 |
| **S4 VLM 看图** | `scripts/vision.mjs` → 调用方注入的 `chatVision` | 游戏画面/活动页/开放语义 | 按图计费 |

顺序：**模板 → OCR → VLM**（先便宜后贵）。任一环失败/不可用就跳过它，**不抛错**。

## 依赖注入（重要）

这个包**不自己实现判定逻辑**，由调用方注入：

| 注入项 | 用途 | 不注入时 |
|---|---|---|
| `extractImages(item)` | 取帖子配图 | 用内置兜底（同规则） |
| `looksLikeCodeAsk(text)` | 求码帖判定 | 兜底=false（宁可多识别，不误判跳过） |
| `detectFriendRequest({title,text})` | 加好友判定 | 兜底=不命中 |
| `looksLikeQuestion(text)` | 求助意图判定 | 兜底=false |
| `chatVision(config, opts)` | 看图渠道 | **跳过 VLM**（只留模板+OCR） |

为什么注入：这些判定在调用方（taptap 版主 skill）里已经有一套**精确实现**，
复制一份必然漂移 —— 调用方改了求码判定，这份不知道，跟着判错。

```js
const pkg = await import('.../pvz2-image-recognition/scripts/image.mjs');
const r = await pkg.enrichPostImages(item, {
  config, log, title, text, cache,
  deps: { extractImages, looksLikeCodeAsk, detectFriendRequest, looksLikeQuestion, chatVision },
});
// r = { text, imageText, images, relevance, skipped, sources, celebrate, entities }
```

## 依赖的外部服务

- **S3 OCR / S6 模板** → 需要一个提供 `/ocr`、`/match` 的本地服务
  （taptap 版主 skill 里是 `scripts/ocr_server.py`，端口 8790，`pip install rapidocr onnxruntime pillow numpy`）
- **S4 VLM** → 需要调用方有多模态渠道（OpenAI 兼容 / Anthropic 兼容）

服务没起 / 缺依赖 → **各自降级跳过**，不阻断主流程。

## 被谁调用

taptap 版主 skill（`taptap-pvz2-forum-moderator`）通过一个**薄壳**
（`scripts/lib/image-bridge.mjs`）调用本包：找到入口 → 动态 import → 注入判定逻辑 →
找不到就**静默跳过图片识别**（主流程照跑）。

入口查找顺序：

1. 环境变量 `DSH_PVZ2_IMAGE`（指向入口文件；设为 `none` = 明确禁用）
2. `~/.dsh/skills/pvz2-image-recognition/scripts/image.mjs`
3. `~/.openclaw/skills/pvz2-image-recognition/scripts/image.mjs`
4. 当前目录同级的 `pvz2-image-recognition/scripts/image.mjs`
5. taptap skill 自带的 `skills/pvz2-image-recognition/scripts/image.mjs`（仓库分发形态）

## 文件

```
scripts/image.mjs        流水线编排（isCodeIntent / imageRelevance / enrichPostImages / defaultRecognize）
scripts/ocr.mjs          RapidOCR 桥接（HTTP 客户端）
scripts/vision.mjs       VLM 看图（渠道由调用方注入）
scripts/features.mjs     S6 模板匹配
scripts/image-cache.mjs  识别结果缓存（按图 url hash + TTL）
assets/game-features/    特征定义 features.json + 模板图 templates/*.png
```

模板库随包分发；新植物/新 UI 只需往 `assets/game-features/templates/` 加图、
在 `features.json` 加一条定义（`trigger:"celebrate"` 的特征命中会标记「庆祝」意图）。
