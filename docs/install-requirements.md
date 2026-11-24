# 依赖矩阵

> 逐项说明：装了什么、为什么装、缺了怎么降级。
> 装法见 [install.md](install.md)，服务部署见 [install-services.md](install-services.md)。

---

## 1. 必需（缺了跑不起来）

| 依赖 | 版本 | 用途 | 安装 | 缺了会怎样 |
|---|---|---|---|---|
| **Node.js** | **≥ 22.5** | 运行时。`lib/db.mjs` 用内置 `node:sqlite` | [nodejs.org](https://nodejs.org) / `nvm install 24` | **直接报错**（`Cannot find module 'node:sqlite'`） |
| **opencli** | 2.x | 驱动已登录的 Chrome，页面内 fetch 发回复 | `npm i -g @jackwener/opencli` | 整个发送链路不可用 |
| **Chrome + opencli 扩展** | — | 登录态载体 | 按 opencli 指引安装 | 同上 |
| **TapTap 登录态** | — | 接口请求带 Cookie | 浏览器里手动登录 | 所有接口 401 |
| `scripts/config.json` | — | appId / groupId / myUserId | `node scripts/install.mjs` | 启动即报缺配置 |
| **taptap-cli** | `@taptap/cli` ≥ 2026.11.11 | 读**帖子全文**与**全部子回复** | `npm i -g @taptap/cli` + `taptap-cli auth login` | 降级到旧接口：正文只 200 字、子回复只前 2 条（**能用，但答不准、幂等会盲判**） |

### Node 版本为什么是 22.5

`lib/db.mjs` 用的是 **Node 内置** `node:sqlite`（零第三方依赖的设计选择）。这个模块：

- 22.5.0 引入（experimental）
- 24.x 稳定

22.5 之前根本没有，装了会在**第一次打开数据库时**崩，不是启动时崩 —— 所以很容易被误判成"别的问题"。

> 2026-11-20 之前 `package.json` 写的是 `>=18`，这是个**真 bug**，已修正为 `>=22.5`，`install.mjs` 也会硬校验。

### 官方 CLI 的权限要求

| 操作 | 需要 | 实测结果 |
|---|---|---|
| 读（帖子/回复/子回复/论坛发现） | **该论坛的版主** | ✅ 普通版主通过 |
| 写（发回复 / 楼中楼） | **论坛主管理员** | ❌ 普通版主 403，`换 token 无效` |

读接口的 `developer_id` 是必填整数，但**不校验归属**（填 `1` 可用）。这是实测行为，不是官方承诺 —— 配置项里做成了可改的 `taptapCli.developerId`。

写接口 403 原文：

```
需要 App 54031 论坛的主管理员权限，你当前是该论坛的普通版主：
请在开发者后台「权限管理 - 论坛主管理员设置」把该用户配置为论坛主管理员。换 token 无效。
```

---

## 2. 推荐（缺了对应功能降级）

| 依赖 | 版本 | 用途 | 缺了会怎样 | 装法 |
|---|---|---|---|---|
| **Python** | 3.8 ~ 3.12 | 跑 OCR / rerank / 模板匹配服务 | 图片识别与重排全部跳过 | [python.org](https://python.org) |
| `rapidocr-onnxruntime` | 任意新版 | 截图 OCR | 图片文字读不到 → 图片帖答不准 | `pip install rapidocr-onnxruntime` |
| `onnxruntime` | 1.19+ | bge-reranker ONNX 推理 | rerank 降级到 LLM 或 RRF | `pip install onnxruntime` |
| `onnx` | 1.17.0 | 仅用于把 fp16 图转 fp32（一次性） | 若模型已是 fp32 则不需要 | `pip install onnx==1.17.0` |
| `tokenizers` | **0.20.3**（钉死） | rerank 分词 | rerank 不可用。更新版本可能不兼容旧 wheel | `pip install tokenizers==0.20.3` |
| `opencv-python` | 任意新版 | 游戏特征模板匹配 | 模板匹配跳过 | `pip install opencv-python` |
| **Ollama** | 任意新版 | `bge-m3` embedding | 退化为 char n-gram，语义召回变差 | [ollama.com](https://ollama.com) |
| `bge-m3` | — | 向量检索 | 同上 | `ollama pull bge-m3` |
| **bge-reranker-v2-m3 ONNX** | — | 重排 | 退化为 RRF/LLM 重排 | **手动放置**，见 [install-services.md](install-services.md#3-rerank-模型) |
| **LLM 渠道** | — | 生成回复正文 | **核心功能不可用**（只能走答疑库原样答案） | 复用 DSH 配置，或填 `llm.apiKey` |
| `baidu-websearch` skill | — | 答疑库没命中时联网补答 | 直接转人工 | 独立 skill |

---

## 3. 可选

| 依赖 | 用途 | 说明 |
|---|---|---|
| PowerShell 7 | 部分运维脚本 | Windows 自带 5.1 也能跑 |
| `better-sqlite3` | **不需要** | 已改用内置 `node:sqlite`，零依赖 |
| Docker | 无 | 本项目不提供镜像 |

---

## 4. 端口占用

| 服务 | 端口 | 启动 | 必需 |
|---|---|---|---|
| OCR / 模板匹配 | **8791** | python <识图skill>/scripts/server.py --port 8791 | 推荐 |
| 检索重排 | **8790** | python scripts/rerank_server.py --port 8790 | 推荐 |
| Ollama（bge-m3） | **11434** | `ollama serve` | 推荐 |
| opencli daemon | 动态 | `opencli daemon start` | **必需** |

冲突排查：

```powershell
Get-NetTCPConnection -LocalPort 8790,8791,11434 -ErrorAction SilentlyContinue |
  Select-Object LocalPort, State, OwningProcess
```

改了端口要同步改配置：

- `image.ocr.server` / `image.features.server` → **8791**（识图 skill 的服务）
- `rerank.server` → **8790**（本 skill 的 rerank_server.py）
- `retrieve.embedEndpoint` → 11434

---

## 5. 版本兼容矩阵（实测）

| 组合 | 结果 |
|---|---|
| Node 24.18 + Python 3.8 + `tokenizers==0.20.3` | ✅ 全套通过（本机环境） |
| Node 22.5 ~ 22.x | ✅ 理论可用（`node:sqlite` 存在），未做长跑验证 |
| Node ≤ 22.4 | ❌ `node:sqlite` 不存在 |
| Python 3.8 + onnxruntime 1.19 + **fp16** ONNX | ❌ `InvalidGraph`（CPU 不支持 fp16 算子） |
| Python 3.8 + onnxruntime 1.19 + **fp32** ONNX | ✅ 正常（8 候选 ≈ 1 秒） |
| `tokenizers` 旧版（< 0.20） | ❌ 加载失败 |

---

## 6. 一键体检

```bash
node scripts/doctor.mjs
```

会逐项报告上面这些依赖的状态，以及**缺失时对应功能怎么降级**。不想猜缺什么就跑它。

`install.mjs` 结尾也会打一张「功能就绪矩阵」，把"缺哪项 → 哪个能力不可用"直接列出来。