# 图片识别 · 本 skill 的接入与运维

> v1.4.0（2026-11-16）引入；**2026-11-24 重构：识别能力独立成 skill `image-recognition-ai-ocr`**。
> 设计依据见 `docs/图片识别-调研报告-20261116.md` + `docs/图片识别-技术设计稿-20261116.md`（历史文档，讲的是拆分前的形态）。
> 本文只讲**本 skill 这一侧**做了什么；识图本身怎么用见识图 skill 的 `SKILL.md` 与 `docs/`。

## 0. 两层分工（记住这个就不会乱）

| 层 | 在哪 | 负责 |
|---|---|---|
| **识图能力** | 独立 skill `image-recognition-ai-ocr` | 图片 → 结构化结果（文字/特征/置信度），任务驱动，零领域耦合 |
| **论坛业务** | 本 skill 的 `scripts/lib/image-recognition.mjs` | 业务门控、相关性判断、回灌文本、注入 PVZ2 prompt 与模板库 |

找不到识图 skill → **跳过图片识别**，主流程照跑（日志说明一句，`skipped='no-image-skill'`）。

## 1. 本 skill 做的三件业务事

1. **业务意图门控**：好友码/天宫码意图 → 跳过图片识别（这类帖按码处理，不读图）。
   判定复用 `lib/code-guard.mjs` 的 `looksLikeCodeAsk` + `lib/mod-task.mjs` 的 `detectFriendRequest`。
2. **业务相关性**：正文长且明确（≥120 字）→ 配图多半是装饰，不值得花钱读；
   正文短 / 像提问 → 读。纯启发式，可配 `image.relevanceGate`。
   （通用「这图有没有信息」由识图 skill 的预筛负责，那是成本判断，不是业务判断。）
3. **回灌**：`post.text = baseText + "\n[图片内容] " + imageText` → QA 匹配 / 联网搜索 / LLM 组答自动受益。

> 注：原来这里还有「求码判定」「提问判定」的复制版 —— 现在**不复制了**，
> 业务判定只在本 skill 存在一份，识图 skill 不掺和业务语义。

## 2. 架构与数据流

```
collect.mjs 取帖（feed item 含 topic.footer_images）
  └ lib/image-recognition.mjs  enrichPostImages(item, {config,title,text,cache})
      ├ extractImages(item)            取图（本 skill 的 http.mjs）
      ├ isCodeIntent                   业务门控1：求码/加好友 → 跳过
      ├ imageRelevance                 业务门控2：装饰配图 → 跳过
      ├ loadTemplates(config)          读本 skill 的 assets/game-features 模板库
      └ recognize({ tasks:['text','feature'], images:[item], extractor:extractImages,
                    prompt: PVZ2_PROMPT, templates, options:{ ocr, features, vision:{chatVision}, prefilter }})
            → 识图 skill：预筛 → OCR/模板/VLM → 结构化结果
      → 汇总 text + features + celebrate → 回灌 post.text
  └ post.text/imageText/images/imageSources → looksQ / QA匹配 / websearch / composeReply
```

**注入关系**（单向，不互相依赖）：

| 从本 skill 注入给识图 skill | 用途 |
|---|---|
| `extractor = extractImages` | 告诉它 TapTap 的图在哪（`moment.topic.footer_images`） |
| `prompt = PVZ2_PROMPT` | 覆盖它内置的通用看图 prompt |
| `templates` | PVZ2 模板库（**库在本 skill**，识图 skill 只提供匹配引擎） |
| `options.vision.chatVision` | 复用本 skill 的模型渠道（`llm.mjs`，跟随 DSH / 他人 key） |
| `options.ocr/features.server` | 指向识图 skill 的本地服务（8791） |

## 3. 取图 schema（实测，evidence/06）

- 图在 **`moment.topic.footer_images[]`**，**不在 contents.json**（topic 帖 type=2 无 contents.json，正文在 title/summary）。
- **feed 层 list item 已带 footer_images** → 取图无需额外 detail 请求。
- 字段：`url/medium_url/small_url/large_url/original_url/original_format/width/height/color/original_size`。OCR/VLM 用 **`original_url`**（原图）。
- **匿名 + `X-UA` 头**即可读（漏 X-UA 报 `INVALID_XUA`，非 WAF）；`ttGet` 已带 X-UA。moment id 用 **`id_str`**。
- CDN `img2-tc.tapimg.com` **无防盗链**，裸 GET 即 200 JPEG。

## 4. 三个通道（实现在识图 skill）

| 通道 | 识图 skill 里的模块 | 引擎 | 适用 | 成本 |
|---|---|---|---|---|
| 模板匹配 | `features.mjs` → `server.py /match` | opencv 多尺度 | 已知植物/奖励图标/UI | 免费离线 |
| OCR | `ocr.mjs` → `server.py /ocr` | RapidOCR（PP-OCRv6） | 错误文案/数字/活动规则/图鉴说明 | 免费离线 |
| VLM | `vision.mjs`（渠道由本 skill 注入） | 跟随 DSH / 他人 key | 游戏画面/活动页/开放语义 | 按图计费 |

顺序恒为 **模板 → OCR → VLM**（先便宜后贵）。

**VLM 渠道**：本 skill 注入 `llm.mjs` 的 `chatVision`——①`config.llm.vision`（apiKey/baseURL/model 齐全）用他人 key；
②否则读 DSH 路由挑 vision-capable 模型（`isVisionModel` 按能力词 `vl/vision/omni` 匹配，**不写死模型名**）；
③都无→降级跳过。多模态 content 经 `toApiContent` 转 openai `image_url` / anthropic `image source`。

## 5. 运维：两个服务，各管一件事

| 服务 | 归属 | 端口 | 接口 |
|---|---|---|---|
| `scripts/server.py` | 识图 skill | **8791** | `/health` `/ocr` `/match` |
| `scripts/rerank_server.py` | **本 skill** | **8790** | `/health` `/rerank` |

```powershell
# 识图服务（OCR + 模板匹配）—— 在识图 skill 目录下
pip install rapidocr onnxruntime pillow numpy
python scripts/server.py --port 8791

# 重排服务（cross-encoder）—— 在本 skill 目录下
pip install onnxruntime tokenizers==0.20.3
python scripts/rerank_server.py --port 8790
```

- 任一服务**未起/缺依赖 → 对应通道降级跳过**，不阻断答疑（其它通道仍可工作）。
- 长期跑建议做成系统服务（同 watch，见 ops.md）。
- 体检：`GET :8791/health` → `{ok:true,engine:"rapidocr",opencv:true}`；`GET :8790/health` → `{ok:true,engine:"cross-encoder"}`。

## 6. 配置（config.json）

```jsonc
"image": {
  "enabled": true,
  "skipIntents": ["friendCode","tiangongCode"],
  "relevanceGate": { "mode":"heuristic", "shortTextLen":30, "longTextLen":120, "unknownAsRelevant":true },
  "ocr":        { "enabled":true, "server":"http://127.0.0.1:8791", "timeoutMs":30000 },
  "vision":     { "enabled":true, "temperature":0.3, "maxTokens":1200, "timeoutMs":90000, "cacheTtlHours":168 },
  "features":   { "enabled":true, "dir":"{{SKILL}}/assets/game-features", "server":"http://127.0.0.1:8791" },
  "prefilter":  { "quality":true, "vlmBinary":true }
},
"rerank": { "backend":"onnx", "server":"http://127.0.0.1:8790" },
"llm": { "vision": { "apiKey":"","baseURL":"","model":"","api":"openai-completions" } }
```

- `ocr.server` / `features.server` 指向**识图 skill** 的服务（8791）；`rerank.server` 指向**本 skill** 的服务（8790）。
- 相关性门控：求助意图/正文短→相关；正文长且明确→配图跳过；判不明默认按相关（`unknownAsRelevant`）。
- 预筛：`quality`=免费质量预筛；`vlmBinary`=先用 VLM 问「这图有信息吗」，无信息就不做后续识别（省成本）。都可关。
- 缓存：`data/image-cache.json`，按图指纹 + 任务签名，TTL `cacheTtlHours`（默认 168h），避免重复识别省钱。

## 7. 扩展游戏特征模板库

**模板库留在本 skill**：`assets/game-features/features.json` + `templates/*.png`
（配置里的 `{{SKILL}}` 解析到**本 skill 根**；运行时由 `loadTemplates()` 读成 base64 传给识图 skill，
识图 skill 只提供匹配引擎，不携带任何领域模板）：

```json
{ "id":"peashooter","name":"豌豆射手","category":"plant","method":"template",
  "template":"templates/peashooter.png","threshold":0.85,"aliases":["豌豆"] }
```

- 从游戏截图裁植物/奖励图标 PNG 放 `templates/`，加条目即可；`pending:true` 表示模板待采集（暂不参与）。
- `threshold` 相似度阈值（0.85 起，识别不到降 0.8/0.7）；多尺度匹配（0.6~3.0）。
- 游戏版本换 UI/新植物 → 补模板。已有样本：`templates/diamond.png`（钻石）、`templates/tile_turnip_card.png` / `tile_turnip_burst.png`（瓷砖萝卜，trigger=celebrate）、`templates/zixuan_item.png` / `zixuan_select.png`（自选碎片/碎片五选一）。均经真实帖图验证。
- **两类触发**：`trigger:"celebrate"`（瓷砖萝卜）→ 自动过去庆祝；**无 trigger**（花盆挂件碎片自选）→ 识别文本并入 `post.text` → QA 候选 → **语义确认门**再决定是否选用。
- **特征要具体，别笼统**：`zixuan_item`=「花盆挂件碎片自选」（拼图+金盆+问号，令营/活动专属）；`zixuan_select`=「碎片五选一」通用使用弹窗，**不单独判定为花盆挂件**（游戏里还有其他自选）。
- **语义确认门**（`lib/semantic-gate.mjs`）：QA 条目带 `- 语义确认：true` 时，命中后先让 LLM 综合语义（正文+图片识别）判断玩家是否真在问这条，确认才选用；不确认/LLM 挂 → 转人工，绝不笼统套用。
- **celebrate 触发**：特征带 `trigger:"celebrate"`（如瓷砖萝卜）→ `loadTemplates` 把它标进 celebrate 集合，识别命中即 `imageCelebrate`；collect 把该帖纳入分享互动并以 `kind=celebrate` **自动过去庆祝**（不只回灌文本）。
- **已知抽取知识**：688 钻=稀有宝箱、2888 钻=传奇宝箱，均为十连 → celebrate 话头**别问「单抽还是十连」**（已是十连），改问「攒了多久钻/下一个想抽啥」。

## 8. 置信度与隐私

- 识别内容属**二手信息**：`compose-reply.mjs` 检测到 `[图片内容]` 会框定「看图里大概是…」，细节以玩家实测为准，不补识别之外的数字（同 webNote 50% 策略）。
- 玩家截图可能含账号信息 → 敏感场景优先本地 OCR/模板；云端 VLM 调用前确认合规。
- VLM key 只在内存用，不落盘/不打印/不进日志（沿用 llm.mjs 铁律）。

## 9. 测试（5 套，离线）

| 测试 | 断言数 | 覆盖 |
|---|---|---|
| `test-image-gate` | 45 | 业务门控（求码/相关）+ 回灌 + 模板加载 + 识图 skill 缺失降级 |
| `test-image-pipeline` | 17 | 缓存 + 任务归一化 + 用真实识图 skill 跑通 OCR 回灌 |
| `test-ocr-bridge` | 11 | OCR 通道契约与降级 |
| `test-vision-channel` | 25 | 本 skill `llm.mjs` 多模态拼装 + 识图 skill 消费注入渠道 |
| `test-features` | 19 | 本 skill 读模板库 + 识图 skill 消费传入模板 |

> 识图 skill 自带 `test/test-all.mjs`（110 断言，覆盖三类任务、预筛、资料层、组合任务、降级语义）。
> 全套 `npm test`（79 套）。

## 10. 已知限制 / 后续

- 模板库植物图标待采集（当前仅钻石/瓷砖萝卜/自选碎片样本）；批量植物检测可后续上 YOLO（标注成本高，暂缓）。
- 业务相关性门控纯启发式起步；通用预筛已上 VLM 二分类（可关）。
- 富文本帖（有 contents.json 内联图）当前取 footer_images 为主；内联图节点待补充实测。