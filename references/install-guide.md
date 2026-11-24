# 安装与依赖（install-guide）

> 日期：2026-11-19（O7）｜ 原则：**只提示不自动装**；装什么由你决定，脚本只负责告诉你缺什么。
> 一键检查：`node scripts/install.mjs`（含「功能就绪矩阵」）或 `node scripts/doctor.mjs`。

## 0. 必备（缺了跑不了）

```bash
# Node ≥ 18（推荐 24；node:sqlite 需要 Node ≥ 22.5 才有，Node 24 稳定）
node -v

# opencli（发帖/回复/表情都靠它驱动已登录的 Chrome）
npm i -g @jackwener/opencli
opencli doctor          # 确认 daemon 在跑、扩展已连接、TapTap 已登录
```

> 浏览器侧需装 opencli 扩展并**登录 TapTap**。没有登录态 → 读接口被 WAF 拦、回复发不出去。

## 1. 答疑主链路（只需 Node + 答疑库）
- `qa/答疑库.md` 直接编辑，格式见 `assets/qa-library.example.md`。
- 无需任何第三方依赖即可跑判定/出报表（`node scripts/watch.mjs --dry-run`）。

## 2. 图片识别（可选，缺则自动降级）

```bash
pip install rapidocr onnxruntime pillow numpy
python ../image-recognition-ai-ocr/scripts/server.py --port 8791   # 识图：/health /ocr /match
python scripts/rerank_server.py --port 8790                      # 重排：/health /rerank
```

- 缺这套 → 图片识别降级跳过，**不阻断答疑**（帖子文本照常处理）。
- VLM 通道（看图理解）：`config.llm.vision` 填 apiKey/baseURL/model，或跟随 DSH 的可视模型；都没有则跳过。

## 3. 向量检索（可选，缺则回落 char-ngram）

```bash
ollama pull bge-m3        # 1024 维，本地免费
ollama serve              # 默认 127.0.0.1:11434
```

- `config.retrieve.denseBackend=bge`（默认）：用 bge-m3 余弦；不可用 → 自动回落 char-ngram。
- 首次建库会 embedding 全部 QA（约 20~30s），之后走 `data/dense-cache.sqlite` 缓存。

## 4. cross-encoder 重排（可选，缺则回落 LLM listwise）

需要的文件（放同一目录，路径填 `config.rerank.modelDir`）：

| 文件 | 说明 |
|---|---|
| `model_quant.onnx` / `model_quantized.onnx` / `model.onnx` | bge-reranker-v2-m3 ONNX（int8 或 fp32） |
| `tokenizer.json` | XLM-R 分词器 |

```bash
pip install onnxruntime tokenizers==0.20.3   # py3.8 必须 pin 0.20.3；更高版本无预编译 wheel
```

- **fp16 图坑**：部分社区 int8 包是 fp16 计算图，py3.8 的 CPU onnxruntime(1.19) 不支持 → 报 `InvalidGraph`。
  免重下的解法：用 `onnx` 库把 fp16 图转 fp32（脚本与步骤见任务目录 `output/PVZ2-P1增强-模型下载教程-20261117.md`）。
- 缺这套 → 回退 LLM listwise 精排，再不行用 RRF 原序，**不阻断答疑**。

## 5. 就绪矩阵（判断"哪些功能能用"）

```bash
node scripts/install.mjs     # 安装向导 + 功能就绪矩阵
node scripts/doctor.mjs      # 只跑自检
```

矩阵含义：
| 标记 | 含义 |
|---|---|
| ✓ | 可用 |
| ✗ | 缺失（会自行降级，不影响其他功能） |
| ? | **未知**（探测命令被沙盒/权限拦，或依赖未装无法判断）—— 不等于缺失，请手动验证 |

## 6. 常见坑

- **WAF**：匿名读接口限流，探测太密会封 IP（实测 >25 分钟不恢复）。别把守护间隔调小、别反复重启。
- **limit 上限 10**：feed 接口一页最多 10 条，翻页靠游标。
- **沙盒环境**：`spawn` 子进程可能被拦（EPERM），就绪矩阵会显示「未知」而不是「缺失」。
- **模型/依赖不随 skill 分发**：本 skill 只带代码与文档；模型文件（~1GB）需自己下载放好。