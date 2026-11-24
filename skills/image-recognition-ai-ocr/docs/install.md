# 安装与依赖 · image-recognition-ai-ocr

## 1. 依赖清单

| 依赖 | 用于 | 必需性 | 缺了会怎样 |
|---|---|---|---|
| Node.js ≥ 18 | 运行全部 JS（用到内置 `fetch`） | **必需** | 跑不起来 |
| Python 3.8+ | 跑本地图像服务 `server.py` | 可选 | OCR / 模板匹配跳过 |
| `rapidocr` `onnxruntime` `pillow` `numpy` | `server.py` 的 OCR | 可选 | OCR 跳过 |
| `opencv-python-headless` | `server.py` 的模板匹配 | 可选 | `/match` 不可用 |
| VLM 渠道（注入或环境变量） | 判断 / 兜底读字 / 特征描述 | 可选 | VLM 类任务跳过 |

**本 skill 零 npm 依赖** —— 不用 `npm install`，不引第三方 JS 包。

> 只需要 `text` 任务的 OCR、又不想装 Python：可以只配 VLM 渠道，让 VLM 兜底读字
> （把 `options.visionFallback` 保持默认 `true`）。

## 2. 安装技能本体

把整个 `image-recognition-ai-ocr/` 目录放到能被找到的位置即可。

```powershell
# 方式一：装进 DSH 的 skills 目录（推荐）
Copy-Item .\image-recognition-ai-ocr $HOME\.dsh\skills\ -Recurse

# 方式二：放在任意位置，用环境变量指过去
$env:DSH_IMAGE_RECOGNITION = "D:\path\to\image-recognition-ai-ocr\scripts\index.mjs"

# 方式三：与调用方 skill 放同一父目录（自动发现，无需配置）
```

### 入口查找顺序

调用方（或你直接 `import`）按下列顺序找入口 `scripts/index.mjs`：

1. 环境变量 `DSH_IMAGE_RECOGNITION`（设为 `none` = 明确禁用，方便测试降级）
2. `~/.dsh/skills/image-recognition-ai-ocr/scripts/index.mjs`
3. `~/.openclaw/skills/image-recognition-ai-ocr/scripts/index.mjs`
4. 当前工作目录同级 `../image-recognition-ai-ocr/scripts/index.mjs`
5. 调用方 skill 自带的 `skills/image-recognition-ai-ocr/scripts/index.mjs`
6. 当前工作目录 `./skills/image-recognition-ai-ocr/scripts/index.mjs`

### 直接 import（自己写脚本时）

```js
// 绝对路径 import，不需要任何查找逻辑
import { recognize } from 'D:/path/to/image-recognition-ai-ocr/scripts/index.mjs';
```

## 3. 本地图像服务（OCR / 模板匹配）

### 3.1 装 Python 依赖

```powershell
pip install rapidocr onnxruntime pillow numpy
# 模板匹配若缺 opencv（rapidocr 一般会带入，没有就补）
pip install opencv-python-headless
```

### 3.2 启动

```powershell
python scripts/server.py                        # 默认 127.0.0.1:8791
python scripts/server.py --port 8791 --host 127.0.0.1
```

### 3.3 体检

```powershell
curl http://127.0.0.1:8791/health
# → {"ok":true,"engine":"rapidocr","opencv":true}
```

`opencv: false` 表示只装了 OCR，模板匹配不可用（其它功能照常）。

### 3.4 接口

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/health` | — | `{ok, engine, opencv}` |
| POST | `/ocr` | `{image: "<base64>"}` | `{ok, text, boxes:[{text,conf}]}` |
| POST | `/match` | `{image, templates:[{id,name,image,threshold}]}` | `{ok, matches:[{id,name,score,loc,scale}]}` |
| POST | `/resize` | `{image, maxSide}` | `{ok, image, width, height, bytes}` —— 缩图给 VLM 用 |

> `/resize` 是为性能加的：VLM 请求体是整张图的 base64，820KB 的图 base64 约 1.1MB，
> 每次换渠道都要重传。本地缩到长边 1024 后通常只剩几十 KB（实测 1094KB → 120KB，135ms）。
> 不过**有公网 URL 时根本不传图**（见 §4「传图方式」），缩图只是兜底。

> **重排（rerank）不在这个服务里** —— 那属检索能力，与识图无关。
> `.taptap-pvz2-forum-moderator` 的 `rerank_server.py`（默认 8790）专门做那件事。

### 3.5 常驻运行

```powershell
# 后台跑（Windows）
Start-Process -WindowStyle Hidden python -ArgumentList "scripts/server.py --port 8791"
```

改 `server.py` 代码后**必须重启进程**才生效。

## 4. 看图渠道（VLM）

**三级解析**，优先级从高到低。任一级命中就用；都没有则降级跳过。

| 级别 | 用途 | 怎么配 |
|---|---|---|
| ① **注入** | 调用方自己有模型路由 | 传 `options.vision.chatVision` |
| ② **自备 KEY** | **给别人用** —— 谁都能填自己的 key | `options.vision.{apiKey,baseURL,model}` 或环境变量 |
| ③ **复用 DSH** | **跟随宿主** —— 在 DSH 里换模型，本 skill 自动跟着换 | 自动读 `~/.dsh/`，无需配置 |

### ① 注入（调用方自己那套路由）

```js
await recognize({
  task: 'text',
  images: [...],
  options: {
    vision: {
      chatVision: async (config, opts) => ({ ok: true, text: '模型回复' }),
      model: 'qwen-vl-max',       // 仅用于结果里标注来源
    },
  },
});
```

`chatVision(config, opts)` 的契约：

- 入参 `opts`：`{ system, messages, temperature, maxTokens, timeoutMs }`
  - `messages` 是 `[{role:'user', content:[{type:'text',text},{type:'image',base64,mediaType}]}]`
- 出参：`{ ok: true, text: '回复文本' }` 或 `{ ok: false, error: '原因' }`

### ② 自备 KEY（给别人用）

两种写法，`config` 优先于环境变量：

```js
// 写法一：运行时传
options: {
  vision: {
    apiKey: 'sk-...',
    baseURL: 'https://api.openai.com/v1',   // 任何 OpenAI 兼容端点
    model: 'gpt-4o-mini',                    // 必须支持图片输入
    api: 'openai-completions',               // 或 'anthropic-messages'
  },
}
```

```powershell
# 写法二：环境变量
$env:IR_VISION_API_KEY  = "sk-..."
$env:IR_VISION_BASE_URL = "https://api.openai.com/v1"
$env:IR_VISION_MODEL    = "gpt-4o-mini"
$env:IR_VISION_API      = "openai-completions"   # 可选，默认 openai-completions
```

也接受 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` 作为兜底命名。

### ③ 复用 DSH 路由（跟随宿主，VLM + LLM 一起用）

默认开启（`options.vision.reuseDsh !== false`）。本 skill 会读：

- `~/.dsh/profiles/web/cordis.patch.yml`（其次 `profiles/default/`）→ providers / **每个模型声明的输入能力** / chain 顺序
- `~/.dsh/.credentials.yaml` → `refs:` 里的 API Key 引用

**判定"能不能看图"以 DSH 声明为准**，不是猜模型名：

```yaml
models:
  - id: qwen3.8-max
    input:
      - text
      - image        # ← 有这一行就算视觉模型
```

依据顺序（前面的更权威）：

1. 白名单 `options.vision.visionModels` —— 显式指定，一票通过
2. **DSH 声明的 `input` 含 `image`** —— 主要依据（**VLM 与通用 LLM 同等对待**：只要声明能收图就能用）
3. 名字里带 `vl` / `vision` / `omni` / `multimodal` —— 没声明时的兜底猜测

排序沿用 DSH 的 chain（当前默认模型在最前），**本 skill 里不出现任何具体模型名** ——
要换模型就在 DSH 里切。

> 实测（2026-11-24 本机）：DSH 的 5 个 provider / 18 个模型里，有 **11 个**声明了 image 输入，
> 本 skill 全部挑得到，按 chain 顺序依次尝试。
> 查当前能挑出哪些渠道：
> `node -e "import('./scripts/vision.mjs').then(async m=>console.log(await m.resolveVisionChannels({})))"`

**注入失败会自动回落**：如果你注入了 `chatVision` 但它一条渠道都没给出来（比如调用方按模型名筛视觉模型、
漏掉了不带 `vl/omni` 字样的通用 LLM），本 skill 会**继续用 ②③ 兜底**，不会白白降级。

### ④ 都没有

VLM 相关能力全部跳过，结果里会出现：

```json
"degraded": ["vlm:no-channel"]
```

OCR 与模板匹配不受影响，照常工作。

### 两种线上风格

| `api` | 请求 | 鉴权 |
|---|---|---|
| `openai-completions`（默认） | `POST {baseURL}/chat/completions` | `Authorization: Bearer <key>` |
| `anthropic-messages` | `POST {baseURL}/v1/messages` | `x-api-key` + `anthropic-version` |

> anthropic 风格渠道会强制 thinking（`thinking.type=disabled` 会被 400 拒），
> 所以本 skill 对这类渠道自动把 `max_tokens` 抬到至少 8000、超时放宽到 150s，
> 并从返回块里跳过 thinking、只取正文。

### 传图方式（性能关键）

**优先传公网 URL**（`options.vision.preferUrl`，默认开）：

```js
// 有公网地址 → 直接把地址交给模型，本地一个字节都不用传
{ type: 'image', url: 'https://cdn.example/a.jpg' }
```

实测：帖子图本来就在 CDN 上，让模型自己去取 —— 本地零上传，
换渠道重试也不会重复上传（这正是之前单张图烧 100 秒的主因）。
没有公网 URL 时才回落到 base64，且**先用本地 `/resize` 缩图**。

### 渠道选择与重试（也是性能关键）

| 机制 | 默认 | 作用 |
|---|---|---|
| 记住上次成功渠道 | 开 | 下次优先用它，省掉试探 |
| 失败渠道冷却 | 10 分钟 | 冷却期内不重试，别拿大 payload 反复白撞 |
| 单次最多试几条 | 4 条 | 不把所有渠道轮一遍 |
| 按实测延迟排序 | 开 | 快模型先试；没实测时按名字先验（flash/mini/small/lite/turbo 优先） |

> **为什么要有「按延迟排序 + 快模型先验」**：实测同一张图，
> `qwen3.8-max` 这类 thinking 模型要 50~80 秒，而 `flash` 级只要 3~5 秒，
> 拿到的东西对下游够用。默认优先试快的，慢的留作兜底。

调参：`options.vision.maxChannelTries` / `channelCooldownMs` / `debug: true`（打印每条渠道耗时）。

## 5. 验证安装成功

```powershell
# ① 自测（全离线，不碰网络也不起 Python）
node test/test-all.mjs
# → 结果：110 通过 / 0 失败

# ② 服务在线检查
curl http://127.0.0.1:8791/health

# ③ 端到端（需服务已启动）
node -e "import('./scripts/index.mjs').then(async m=>{const r=await m.recognize({task:'text',images:['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='],options:{prefilter:{vlmBinary:false}}});console.log(JSON.stringify(r.meta,null,2))})"
```

## 6. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `degraded: ['vlm:no-channel']` | 没注入 `chatVision` 也没配环境变量 | 按 §4 配一个 |
| `degraded: ['ocr:img1:HTTP 500']` | 本地服务没起 / 缺 Python 依赖 | `python scripts/server.py` |
| `degraded: ['template:no-templates']` | 没传 `templates` | 传自己的模板库 |
| `degraded: ['match:img1:unparsable']` | 模型没按 JSON 格式回 | 一般偶发；持续出现换更强模型 |
| `skipped: [{reason:'no-info'}]` | VLM 二分类判定无信息 | 想强识 → `prefilter.vlmBinary = false` |
| `skipped: [{reason:'too-small'}]` | 图确实太小（<100 字节） | 检查图片源 |
| 结果全是 `confidence: 0` | `intents[].id` 与模型返回对不上 | id 用简单英文标识（`error_dialog` 而非长句） |
| 判断很慢 | 每张图都调一次 VLM | 用 `onlyBest: true` 减输出；或关掉 VLM 预筛 |

## 7. 卸载

```powershell
Remove-Item $HOME\.dsh\skills\image-recognition-ai-ocr -Recurse
# 若配过环境变量，一并清掉
Remove-Item Env:DSH_IMAGE_RECOGNITION -ErrorAction SilentlyContinue
```

调用方会检测不到识图 skill，自动跳过图片识别（不报错）。