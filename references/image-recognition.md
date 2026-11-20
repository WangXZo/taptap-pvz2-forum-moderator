# 图片识别流水线（S1–S6）· 分析与运维

> v1.4.0（2026-11-16）。设计依据见 skill 内 `docs/图片识别-调研报告-20261116.md` + `docs/图片识别-技术设计稿-20261116.md`（取图实测证据 `docs/evidence/06-图片取图schema实测-20261116.md` + 活动页面样本图）。
> 本文是 skill 内的实现说明 + 运维手册。改图片识别代码前先读这里。

## 1. 为什么做 / 三条规则

论坛大量帖带图（求助截图、**活动页面**、**植物图鉴**、晒卡），旧版零图片识别。大哥拍板的**带门控流水线**：

1. **好友码/天宫码意图 → 跳过图片识别**（走原固定提醒/撮合流程，不读图）。
2. **其他帖先判图片相关性**（纯启发式起步）：无关配图跳过、相关图才识别。
3. **识别内容并入 `post.text`** → QA 匹配 / 联网搜索 / LLM 组答**自动受益**（复用现有通道，不新建）。

## 2. 架构与数据流

```
collect.mjs 取帖（feed item 含 topic.footer_images）
  └ enrichPostImages(item, {config,title,text,cache})   lib/image.mjs
      ├ extractImages(item)            http.mjs → post.images[{url=original_url,...}]
      ├ 规则1 isCodeIntent             码/好友意图 → skipped=code-intent
      ├ 规则2 imageRelevance           启发式 → decorative 跳过 / relevant 识别
      └ defaultRecognize（可注入）
          ├ S6 matchFeatures           lib/features.mjs → 模板匹配（本地免费）
          ├ S3 ocrImages               lib/ocr.mjs → RapidOCR 文字
          └ S4 describeImages          lib/vision.mjs → VLM 语义
      → text = baseText + "\n[图片内容] " + imageText
  └ post.text/imageText/images/imageSources → looksQ / QA匹配 / websearch / composeReply
```

## 3. 取图 schema（实测，evidence/06）

- 图在 **`moment.topic.footer_images[]`**，**不在 contents.json**（topic 帖 type=2 无 contents.json，正文在 title/summary）。
- **feed 层 list item 已带 footer_images** → 取图无需额外 detail 请求。
- 字段：`url/medium_url/small_url/large_url/original_url/original_format/width/height/color/original_size`。OCR/VLM 用 **`original_url`**（原图）。
- **匿名 + `X-UA` 头**即可读（漏 X-UA 报 `INVALID_XUA`，非 WAF）；`ttGet` 已带 X-UA。moment id 用 **`id_str`**。
- CDN `img2-tc.tapimg.com` **无防盗链**，裸 GET 即 200 JPEG。

## 4. 各识别手段

| 手段 | 模块 | 引擎 | 适用 | 成本 |
|---|---|---|---|---|
| S3 OCR | `lib/ocr.mjs` + `ocr_server.py /ocr` | RapidOCR（PP-OCRv6） | 错误文案/数字/活动规则/图鉴说明文本 | 免费离线 |
| S4 VLM | `lib/vision.mjs` + `llm.mjs chatVision` | 跟随 DSH / 他人 key | 游戏画面/活动页/图鉴开放语义 | 按图计费 |
| S6 模板 | `lib/features.mjs` + `ocr_server.py /match` | opencv 多尺度模板匹配 | 已知植物/奖励图标/UI | 免费离线 |

**VLM 渠道（跟随 DSH + 他人 key）**：`resolveVisionChannels` 沿用 `resolveChannels` 两条路——①`config.llm.vision`（apiKey/baseURL/model 齐全）用他人 key；②否则读 DSH 路由挑 vision-capable 模型（`isVisionModel` 按能力词 `vl/vision/omni` 匹配，**不写死模型名**）；③都无→降级。多模态 content 经 `toApiContent` 转 openai `image_url` / anthropic `image source`。

## 5. 运维：起本地图像服务

OCR 与模板匹配共用一个 Python 微服务（`scripts/ocr_server.py`，监听 127.0.0.1:8790）：

```powershell
pip install rapidocr onnxruntime pillow numpy   # 首次（opencv 随 rapidocr 带入）
python scripts/ocr_server.py --port 8790         # /health /ocr /match
```

- 服务**未起/缺依赖 → OCR/模板各自降级跳过**，不阻断答疑（VLM 仍可独立工作）。
- 长期跑建议做成系统服务（同 watch，见 ops.md）。
- 体检：`GET /health` → `{ok:true,engine:"rapidocr"}`。

## 6. 配置（config.json）

```jsonc
"image": {
  "enabled": true,
  "skipIntents": ["friendCode","tiangongCode"],
  "relevanceGate": { "mode":"heuristic", "shortTextLen":30, "longTextLen":120, "unknownAsRelevant":true },
  "ocr":      { "enabled":true, "server":"http://127.0.0.1:8790", "timeoutMs":30000 },
  "vision":   { "enabled":true, "temperature":0.3, "maxTokens":1200, "timeoutMs":90000, "cacheTtlHours":168 },
  "features": { "enabled":true, "dir":"{{SKILL}}/assets/game-features", "server":"http://127.0.0.1:8790" }
},
"llm": { "vision": { "apiKey":"","baseURL":"","model":"","api":"openai-completions" } }
```

- 相关性门控：求助意图/正文短→相关；正文长且明确→配图跳过；判不明默认按相关（`unknownAsRelevant`）。
- 缓存：`data/image-cache.json`，按图 url hash，TTL `cacheTtlHours`（默认 168h），避免重复识别省钱。

## 7. 扩展游戏特征模板库（S6）

`assets/game-features/features.json` + `templates/*.png`：

```json
{ "id":"peashooter","name":"豌豆射手","category":"plant","method":"template",
  "template":"templates/peashooter.png","threshold":0.85,"aliases":["豌豆"] }
```

- 从游戏截图裁植物/奖励图标 PNG 放 `templates/`，加条目即可；`pending:true` 表示模板待采集（暂不参与）。
- `threshold` 相似度阈值（0.85 起，识别不到降 0.8/0.7）；多尺度匹配（1.0/0.9/0.8/1.1/0.7/1.2）。
- 游戏版本换 UI/新植物 → 补模板。已有样本：`templates/diamond.png`（钻石）、`templates/tile_turnip_card.png` / `tile_turnip_burst.png`（瓷砖萝卜，trigger=celebrate）、`templates/zixuan_item.png` / `zixuan_select.png`（自选碎片/碎片五选一，真实帖图验证通过）。均经真实帖图验证。
- **两类触发**：`trigger:"celebrate"`（瓷砖萝卜）→ 自动过去庆祝；**无 trigger**（花盆挂件碎片自选）→ 识别文本并入 `post.text` → QA 候选 → **语义确认门**再决定是否选用。
- **特征要具体，别笼统**：`zixuan_item`=「花盆挂件碎片自选」（拼图+金盆+问号，令营/活动专属）；`zixuan_select`=「碎片五选一」通用使用弹窗，**不单独判定为花盆挂件**（游戏里还有其他自选）。
- **语义确认门**（`lib/semantic-gate.mjs`）：QA 条目带 `- 语义确认：true` 时，命中后先让 LLM 综合语义（正文+图片识别）判断玩家是否真在问这条，确认才选用；不确认/LLM 挂 → 转人工，绝不笼统套用。
- **celebrate 触发**：特征带 `trigger:"celebrate"`（如瓷砖萝卜）→ 识别到即标记 `imageCelebrate`；collect 把该帖纳入分享互动并以 `kind=celebrate` **自动过去庆祝**（不只回灌文本）。后续任何帖识别到瓷砖萝卜都会自动过去，不限于某两帖。
- **已知抽取知识**：688 钻=稀有宝箱、2888 钻=传奇宝箱，均为十连 → celebrate 话头**别问「单抽还是十连」**（已是十连），改问「攒了多久钻/下一个想抽啥」。
- 匹配尺度已放宽（0.6~3.0），小模板（用户给的截图截取）可放大匹配高分辨率帖图中的图标。

## 8. 置信度与隐私

- 识别内容属**二手信息**：`compose-reply.mjs` 检测到 `[图片内容]` 会框定「看图里大概是…」，细节以玩家实测为准，不补识别之外的数字（同 webNote 50% 策略）。
- 玩家截图可能含账号信息 → 敏感场景优先本地 OCR/模板；云端 VLM 调用前确认合规。
- VLM key 只在内存用，不落盘/不打印/不进日志（沿用 llm.mjs 铁律）。

## 9. 测试（5 套，离线）

`test-image-gate`（门控/回灌 29）· `test-ocr-bridge`（OCR 契约 12）· `test-vision-channel`（视觉渠道/多模态 20）· `test-image-pipeline`（缓存/编排 12）· `test-features`（模板匹配 12）。OCR/模板另经真实活动页面样本端到端验证。全套 `npm test`（33 套）。

## 10. 已知限制 / 后续

- 模板库植物图标待采集（当前仅钻石样本）；批量植物检测可后续上 YOLO（标注成本高，暂缓）。
- 相关性门控纯启发式起步，VLM 二分类按需后开。
- 富文本帖（有 contents.json 内联图）当前取 footer_images 为主；内联图节点待补充实测。