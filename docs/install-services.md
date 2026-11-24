# 本地服务与模型

> 可选能力。不装也能跑（对应功能降级），装了答得更准。
> 依赖清单见 [install-requirements.md](install-requirements.md)。

---

## 总览

**两个服务，各管一件事**（2026-11-24 拆分：识图归识图，检索归检索）：

```
识图 skill（image-recognition-ai-ocr）的 scripts/server.py
  :8791/health     健康检查
  :8791/ocr        截图文字识别（RapidOCR）
  :8791/match      特征模板匹配（OpenCV）

本 skill 的 scripts/rerank_server.py
  :8790/health     健康检查
  :8790/rerank     检索重排（bge-reranker-v2-m3 ONNX）

ollama serve
  :11434           bge-m3 embedding（向量检索）
```

三者相互独立：rerank 挂了不影响 OCR，OCR 挂了不影响答疑（只是图片帖答不准）。
识图 skill 与「论坛版主」两个 skill 可各自独立安装使用。

---

## 1. Python 环境

```bash
python --version     # 3.8 ~ 3.12

# 识图 skill 要的（OCR + 模板匹配）
pip install rapidocr onnxruntime pillow numpy opencv-python-headless

# 本 skill 的重排要的
pip install onnxruntime "tokenizers==0.20.3"
```

> `tokenizers` 必须 0.20.3：更新版本在旧 Python（3.8）上可能没有可用 wheel，装不上。

`onnx` 只在需要转换模型格式时安装（见 §3.2），平时不必。

---

## 2. 启动服务

### 2.1 识图服务（OCR / 模板匹配，8791）

```bash
# 在识图 skill 目录下
python scripts/server.py --port 8791
```

期望输出：

```
[image-recognition-ai-ocr] 就绪，监听 http://127.0.0.1:8791 （/health /ocr /match）
```

### 2.2 重排服务（8790）

```bash
# 在本 skill 目录下
python scripts/rerank_server.py --port 8790
```

期望输出：

```
[rerank_server] 就绪，监听 http://127.0.0.1:8790 （/health /rerank）。OCR/模板匹配在 image-recognition-ai-ocr（8791）
```

### 2.3 验证

```bash
curl http://127.0.0.1:8791/health    # → {"ok":true,"engine":"rapidocr","opencv":true}
curl http://127.0.0.1:8790/health    # → {"ok":true,"engine":"cross-encoder","loaded":[]}
```

改了任一服务的代码，**必须重启对应进程**才生效。

配置对应项：

```json
// scripts/config.json
"image": {
  "ocr":      { "enabled": true, "server": "http://127.0.0.1:8791" },
  "features": { "enabled": true, "server": "http://127.0.0.1:8791" }
},
"rerank": { "backend": "onnx", "server": "http://127.0.0.1:8790" }
```

> 识图 skill 没装 → `image.ocr` / `image.features` 相关自动跳过，主流程照跑。

---

## 3. rerank 模型

### 3.1 需要什么

**bge-reranker-v2-m3** 的 ONNX 版本，约 **1.5 GB**。

默认查找位置（`rerank.modelDir`）：

```
E:\Ollama\models\bge-reranker-v2-m3
```

目录里应有 `model_quantized.onnx`（加载器优先认它）。

### 3.2 ⚠️ fp16 问题（踩过，必读）

公开的 `arnauld-a/bge-reranker-v2-m3-onnx-quant` 是 **fp16 计算图**。把 int8 量化版直接扔给 **CPU 上的 onnxruntime 1.19 + Python 3.8**，会报：

```
InvalidGraph: ... fp16 ... not supported
```

CPU 版 ORT 不支持 fp16 算子。

**解决办法：把计算图转成 fp32**（只转图，不改权重精度）：

```bash
pip install "onnx==1.17.0"
python <skill>/work/fix-fp16-onnx.py
```

脚本会在**原文件旁边**生成 `model_quantized.onnx`（fp32），**不改动原文件**。加载器优先认 fp32 那个。

转换后 `/rerank` 处理 8 个候选约 **1 秒**。

### 3.3 模型从哪来

> **本项目不提供模型文件，也不提供下载脚本。**
> 模型体积大、来源与许可需自行确认，请手动获取后放到上述目录。

放置后验证：

```bash
curl -X POST http://127.0.0.1:8790/rerank \
  -H "Content-Type: application/json" \
  -d '{"query":"猕猴桃碎片怎么用","candidates":["碎片够了解锁植物","猕猴桃升阶要30个"]}'
```

应返回带分数的排序结果。

### 3.4 不装会怎样

`rerank.backend` 会在失败时**自动降级**：`onnx → llm → RRF`。

RRF 是纯本地算法（k=60），效果比 ONNX 差但能用。所以 rerank 是可选的。

想彻底关掉：

```json
"rerank": { "backend": "off" }
```

---

## 4. Ollama 与 bge-m3（向量检索）

```bash
ollama serve            # 监听 11434
ollama pull bge-m3
```

验证：

```bash
curl http://127.0.0.1:11434/api/tags
```

配置：

```json
"retrieve": {
  "denseBackend": "bge",
  "embedModel": "bge-m3",
  "embedEndpoint": "http://127.0.0.1:11434"
}
```

### 不装会怎样

`denseBackend: "bge"` 连不上时**自动退化为 `char`**（字符 n-gram TF-IDF）。

差别：
- `bge`：能理解同义说法（"碎片用不了" ↔ "无法解锁植物"）
- `char`：只认字面重叠

想强制零依赖：

```json
"retrieve": { "denseBackend": "char" }
```

embedding 结果会缓存到 `data/dense-cache.sqlite`，所以不是每次都调 Ollama。

---

## 5. LLM 渠道

回复正文由 LLM 生成。两种配法：

### A. 复用 DSH 配置（推荐）

```json
"llm": { "enabled": true, "reuseDsh": true }
```

跟随你在 GUI 里选的模型，**不用填任何 key**。

### B. 自己填（给其他人用）

```json
"llm": {
  "enabled": true,
  "reuseDsh": false,
  "apiKey": "sk-...",
  "baseURL": "https://api.openai.com/v1",
  "model": "gpt-4o-mini",
  "api": "openai-completions"
}
```

### 成本护栏

```json
"llm": { "dailyCallCap": 300 }
```

每天最多 300 次调用，超了**快速失败转人工**（不会硬编、不会偷偷超额）。`0` = 不限。

调用计数写 `data/llm-usage.json`，日报会显示今日用量。

### 不装会怎样

组答不可用 → 只能把答疑库答案原样发出（质量差很多），或者大量转人工。

---

## 6. 服务健康与降级

所有外部服务都是**可失败**的，任一挂掉不影响主链路：

| 服务 | 失败时 |
|---|---|
| OCR | 跳过图片文字，只用帖文本 |
| VLM | 同上 |
| 模板匹配 | 跳过 |
| rerank | `onnx → llm → RRF` |
| embedding | `bge → char` |
| 官方 CLI | 回退旧接口（正文 200 字、子回复前 2 条） |
| LLM | 转人工 |

查当前状态：

```bash
node scripts/doctor.mjs
```

---

## 7. 启动顺序

```bash
# ① 服务先起
python <识图skill>/scripts/server.py --port 8791    # OCR / 模板匹配
python scripts/rerank_server.py --port 8790         # 检索重排
ollama serve

# ② 再起守护
node scripts/watch.mjs
node scripts/mod-watch.mjs
```

反了也不会崩（守护会重试），但第一次请求可能因服务未就绪而降级，日志里会出现跳过记录。