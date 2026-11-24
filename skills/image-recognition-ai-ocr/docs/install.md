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

> **重排（rerank）不在这个服务里** —— 那属检索能力，与识图无关。
> `.taptap-pvz2-forum-moderator` 的 `rerank_server.py`（默认 8790）专门做那件事。

### 3.5 常驻运行

```powershell
# 后台跑（Windows）
Start-Process -WindowStyle Hidden python -ArgumentList "scripts/server.py --port 8791"
```

改 `server.py` 代码后**必须重启进程**才生效。

## 4. 看图渠道（VLM）

三选一，优先级从高到低：

### ① 注入（推荐，调用方自己那套路由）

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

### ② 环境变量（本 skill 自带的 OpenAI 兼容客户端）

```powershell
$env:IR_VISION_API_KEY  = "sk-..."
$env:IR_VISION_BASE_URL = "https://api.openai.com/v1"   # 任何 OpenAI 兼容端点
$env:IR_VISION_MODEL    = "gpt-4o-mini"                 # 必须支持图片输入
```

也接受 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 作为兜底命名。

### ③ 不配

VLM 相关能力全部跳过，结果里会出现：

```json
"degraded": ["vlm:no-channel"]
```

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

调用方会检测不到能力包，自动跳过图片识别（不报错）。