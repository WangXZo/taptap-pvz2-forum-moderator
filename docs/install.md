# 安装

> 适用版本：v2.0 起（2026-11-20 之后）。
> 旧版说明见 git 历史；本版起 Node 最低版本改为 **22.5**。

---

## 0. 五分钟快速开始

```bash
# 1) 装 Node（≥22.5，推荐 24.x）
node -v            # 必须 ≥ v22.5.0

# 2) 装两个 CLI
npm i -g @jackwener/opencli     # 驱动浏览器（写回复用）
npm i -g @taptap/cli            # 官方 CLI（读全文/全子回复用）

# 3) 装浏览器扩展并登录
#    Chrome 装 opencli 扩展 → 浏览器里登录 www.taptap.cn → opencli daemon start
opencli daemon start

# 4) 官方 CLI 登录取 token
taptap-cli auth login           # 按提示扫码

# 5) 放好 skill，然后配置 + 自检
cd <skill 目录>
node scripts/install.mjs        # 逐项补全配置
node scripts/doctor.mjs         # 全绿才继续

# 6) 只读试跑（不发任何东西）
node scripts/collect.mjs --dry-run

# 7) 起守护
node scripts/watch.mjs
```

> ⚠️ 第 2 步的 `@taptap/cli` **不能省**。没有它，帖子正文只能读到 200 字、子回复只能读到前 2 条（详见 [为什么需要它](#为什么需要一个官方-cli)）。

---

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| **Node.js** | **≥ 22.5** | 用内置 `node:sqlite`（`lib/db.mjs`）。22.5 之前没有这个模块，装上也会**运行时报错** |
| 操作系统 | Windows 10+ / macOS / Linux | 命令示例以 Windows PowerShell 为主 |
| 磁盘 | ≥ 2 GB 空闲 | 主要给 rerank 模型（1.5 GB）和运行数据 |
| 内存 | ≥ 4 GB | rerank + OCR 同时起时占用较高 |
| 网络 | 能访问 `www.taptap.cn`、`api.tapapis.cn` | 官方 CLI 走 `api.tapapis.cn` |
| 浏览器 | Chrome（已登录 TapTap） | opencli 的宿主 |

详细依赖矩阵见 **[install-requirements.md](install-requirements.md)**。

---

## 2. 安装步骤

### 2.1 装 Node

```bash
node -v
# v24.x.x  ✅
# v22.5.x  ✅（恰好够）
# v22.4.x  ❌ 太老
# v20.x    ❌ 太老
```

用 nvm 的话：

```bash
nvm install 24
nvm use 24
```

### 2.2 装 opencli 与浏览器扩展

```bash
npm i -g @jackwener/opencli
opencli --version
```

然后在 Chrome 里安装 opencli 扩展（按 opencli 官方指引），并**登录 www.taptap.cn**。

```bash
opencli daemon start
opencli browser tap open https://www.taptap.cn/     # 验证能开页
```

> `tap` 是会话名，可在 `reply.session` 改。mod-watch 默认另用 `tapmod`，两者不抢标签页。

### 2.3 装官方 CLI 并登录

```bash
npm i -g @taptap/cli
taptap-cli auth status
# 期望看到：认证: Bearer Token / Bearer: 有效（过期时间 ...）
```

没登录就先登录：

```bash
taptap-cli auth login      # 按提示扫码授权
```

**权限要求（重要）**：

| 操作 | 需要什么 | 说明 |
|---|---|---|
| 读帖子全文 / 回复 / 子回复 | **该论坛的版主** | 普通版主就够 |
| 发回复（写接口） | **论坛主管理员** | 普通版主会 403，**换 token 无效** |

如果只是版主：读全通，写继续走浏览器通道（默认行为，无需额外配置）。
如果你被配成论坛主管理员：可以把 `taptapCli.writeEnabled` 打开，写也走官方 CLI。

配置位置：开发者后台 → **权限管理** → **论坛主管理员设置**。

### 2.4 放置 skill

把整个 skill 目录放到任意位置（路径含中文/空格都行，`{{SKILL}}` 会自动展开）。推荐：

```
C:\Users\<你>\.dsh\skills\taptap-pvz2-forum-moderator\
```

### 2.5 生成配置

```bash
cd <skill 目录>
node scripts/install.mjs
```

它会：
1. 检查 Node / opencli / 浏览器扩展 / taptap-cli
2. 补全 `scripts/config.json` 的关键项（appId / groupId / myUserId / 签名）
3. 建好 `data/` `reports/` `qa/归档/`
4. 打印**功能就绪矩阵**（哪些能力缺依赖、会怎么降级）
5. 跑一遍 `doctor`

一次性指定参数（给脚本/CI 用）：

```bash
node scripts/install.mjs --app-id 54031 --group-id 40173 --my-user-id 你的UID --signature "「版主助手-小鲸鱼」"
```

拿自己的 user_id：

```bash
node scripts/whoami.mjs        # 要求浏览器已登录 TapTap
```

### 2.6 自检

```bash
node scripts/doctor.mjs
```

要看到这几项是 ✓：

- Node 版本
- 配置文件 / 核心模块 / 答疑库 / 参考资料
- appId / groupId / myUserId / 签名
- 浏览器桥接（opencli）
- 答疑库能加载

`taptap-cli` 未装只会让"读全文/全子回复"降级，不影响启动，但**强烈建议装上**。

---

## 3. 可选能力（按需）

缺了不影响启动，只是对应功能降级（`install.mjs` 的"功能就绪矩阵"会明确告诉你缺什么）。

| 能力 | 需要什么 | 缺了会怎样 |
|---|---|---|
| 图片 OCR | Python + `rapidocr-onnxruntime` + `scripts/ocr_server.py` | 截图内容不识别，图片帖答不准 |
| 重排（rerank） | Python + `onnxruntime` + `tokenizers==0.20.3` + 模型文件 | 退化为 RRF/LLM 重排，检索略差 |
| 向量检索 | Ollama + `bge-m3` | 退化为字符 n-gram，语义召回变差 |
| 联网补答 | `baidu-websearch` skill | 答疑库没命中时直接转人工 |
| 评价分析 | 手动喂数据 | 默认关闭，不影响主链路 |

部署步骤见 **[install-services.md](install-services.md)**。

---

## 4. 验证

### 4.1 只读试跑

```bash
node scripts/collect.mjs --dry-run
```

看日志里是否出现：

```
[讨论] 官方 CLI：N 条一级 / M 条子回复     ← 说明 CLI 通道生效
```

### 4.2 单帖试发（可选，会真的发出去）

先确认 `reply.dryRun=false`，然后让守护跑一轮，或手动指定。

**发布前务必确认签名与群里口径一致。**

### 4.3 起守护（顺序不能乱）

```bash
# ① 先起 Python 服务（如果要用 OCR/rerank）
python scripts/ocr_server.py --port 8790

# ② 答疑守护
node scripts/watch.mjs

# ③ 管理任务守护（另开窗口，用另一个 opencli 会话）
node scripts/mod-watch.mjs
```

> 顺序反了容易抢浏览器标签页。三者可以同时跑，但**必须按 ①②③ 起**。

---

## 5. 升级

```bash
git pull                      # 或重新解压
node scripts/install.mjs      # 补齐新配置项（幂等，不会覆盖你已写的值）
node scripts/doctor.mjs
```

配置升级是**增量**的：新参数会自动补默认值，你改过的不动。

---

## 6. 卸载

删 skill 目录即可。它不写注册表、不装系统服务、不常驻。

浏览器扩展和两个 CLI 可单独卸：

```bash
npm uninstall -g @jackwener/opencli @taptap/cli
```

---

## 附录 A · 目录结构

```
<skill>/
  SKILL.md                 技能入口（给 AI 读）
  scripts/
    config.json            你的配置
    config/schema.json     配置权威定义（改默认值改这里）
    lib/                   内核模块
    plugins/               通道插件
    workers/               发送线程
  qa/答疑库.md              知识库
  references/              详细文档
  docs/                    安装与配置文档（本目录）
  data/                    运行数据（自动创建）
  reports/                 报告与 trace（自动创建）
```

## 附录 B · 为什么需要一个官方 CLI

旧读接口（`/webapiv2/moment/v3/detail`、`/moment-comment/v1/by-moment`）有两个**平台级硬截断**：

| 问题 | 表现 | 后果 |
|---|---|---|
| 正文只给摘要 | `topic.summary` **恒定 200 字**，5 种参数组合都一样，无全文字段 | 长帖答偏（曾自己回复"正文断在这儿了？"） |
| 子回复只给前 2 条 | `child_posts` 截断，且 `by-comment` 400 / `child`、`by-parent` 404 | 自己发的子回复读不到 → 幂等盲判；漏读关键答案 |

官方 CLI 一次解决：

| 能力 | 实测结果 |
|---|---|
| `get-community-moment` → `content` | **954 字全文**（同帖的 summary 仍是 200） |
| `list-community-moment-child-replies` → `total` | **5 条全量**（旧接口 2 条） |

## 附录 C · 首次运行检查清单

- [ ] `node -v` ≥ 22.5
- [ ] `opencli --version` 有输出
- [ ] Chrome 已登录 TapTap，`opencli daemon start` 成功
- [ ] `taptap-cli auth status` 显示 Bearer 有效
- [ ] `node scripts/install.mjs` 走完无红色 ✗
- [ ] `node scripts/doctor.mjs` 关键项全 ✓
- [ ] `node scripts/collect.mjs --dry-run` 出现 `[讨论] 官方 CLI：…`
- [ ] 三个守护按 ①②③ 顺序起，日志无报错
- [ ] `reports/` 下开始出现 `trace-<日期>.jsonl`