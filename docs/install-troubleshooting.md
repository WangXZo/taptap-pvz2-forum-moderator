# 安装与运行故障排查

> 这里记的都是**实际踩过的坑**，附现象、原因、做法。
> 装法见 [install.md](install.md)。

---

## 快速自检顺序

```bash
node -v                      # ① ≥22.5
opencli --version            # ② 有输出
taptap-cli auth status       # ③ Bearer 有效
node scripts/doctor.mjs      # ④ 关键项全 ✓
node scripts/collect.mjs --dry-run   # ⑤ 能看到 [讨论] 官方 CLI
```

哪一步不过就往下查对应小节。

---

## A. Node 相关

### A1. `Cannot find module 'node:sqlite'`

**现象**：启动就崩，或第一次拉数据时崩。

**原因**：Node < 22.5，内置 `node:sqlite` 不存在。

**做法**：

```bash
node -v
# v22.4 及以下 → 升级
nvm install 24 && nvm use 24
```

`install.mjs` 和 `doctor.mjs` 都会拦这一项。

---

## B. 官方 CLI（taptap-cli）

### B1. `failed to lock TapTap config C:\Users\...\.taptap-cli\taptap.json`

**现象**：任何 `taptap-cli` 命令都返回这个错误，即使没有其他进程在跑。

**原因**：上次异常退出留下**僵死的锁文件**（0 字节）。

**做法**：

```powershell
# 确认没有 taptap-cli / node 进程在跑
Get-Process node -ErrorAction SilentlyContinue

# 删掉僵死锁（0 字节，删了 CLI 会自己重建）
Remove-Item "$env:USERPROFILE\.taptap-cli\taptap.lock" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.taptap-cli\update-state.json.lock" -Force -ErrorAction SilentlyContinue

taptap-cli auth status
```

### B2. `--data invalid format, expected JSON object`

**现象**：参数明明是对的，却报 JSON 格式错。

**原因**：Windows PowerShell 的三重坑叠在一起：

1. 管道 `'{"a":"b"}' | taptap-cli ... --data -` 会被 PowerShell 改写引号
2. `Set-Content -Encoding utf8` 在 PowerShell 5 会**写 BOM**，CLI 不认
3. 内联 `--data '{"a":"b"}'` 里嵌套 JSON 需要转义，容易漏

**做法**：**用文件，并且确保 UTF-8 无 BOM**。

```powershell
# ❌ 这样写的文件带 BOM
'{"app_id":"54031"}' | Set-Content -Path d.json -Encoding utf8

# ✅ 用 .NET 写无 BOM（CLI 官方提示的做法）
[System.IO.File]::WriteAllText("$PWD\d.json", '{"app_id":"54031"}', (New-Object System.Text.UTF8Encoding($false)))

taptap-cli community-management search-community-forums --app-id 54031 --data "@d.json" --json
```

> `--data` 的路径**必须在当前工作目录内**（相对路径）。所以在 skill 根目录跑最好。

本项目里的 `lib/taptap-cli.mjs` 已经处理好了：它把临时文件写到 `data/tmp/`，用 `writeFileSync` 写（天然无 BOM），用完删掉。**你不必手动处理**。

### B3. `403 permission_denied`（发回复时）

**现象**：

```
无权访问目标资源（需要 App 54031 论坛的主管理员权限，
你当前是该论坛的普通版主：请在开发者后台「权限管理 - 论坛主管理员设置」
把该用户配置为论坛主管理员。换 token 无效。）
```

**原因**：官方 CLI 的**写接口**要求论坛主管理员。普通版主只能读。

**做法**（二选一）：

1. **保持普通版主** → 什么都不用做。`taptapCli.writeEnabled` 默认 `false`，写走浏览器通道，功能正常。
2. **想用官方 CLI 写** → 让有权限的人在开发者后台把你配成论坛主管理员，然后把
   `config.json` 的 `taptapCli.writeEnabled` 改成 `true`。

**不要尝试换 token / 重新登录** —— 错误信息明确说了无效。

### B4. `--data` 里 `moment_intent` 报 `must be one of: 1, 2`

**现象**：传 `[1]` 仍被拒。

**做法**：这个字段的校验比较挑，先用不带它的查询拉全量，自己再筛。

```json
{"app_id":"54031","developer_id":1,"order":"published","page":1,"page_size":20}
```

### B5. `developer_id` 报 `expected integer, got string`

**原因**：必须是 JSON **数字**，不能是字符串。

```json
{"developer_id": 1}      ✅
{"developer_id": "1"}    ❌
```

---

## C. opencli / 浏览器

### C1. `没找到 opencli`

```bash
npm i -g @jackwener/opencli
opencli --version
```

如果装完还说找不到，检查 npm 全局 bin 是否在 PATH：

```powershell
npm prefix -g
# 把 <prefix> 加进 PATH，或直接用完整路径
```

### C2. 浏览器扩展没连上

```bash
opencli daemon start
opencli browser tap open https://www.taptap.cn/
```

- 确认 Chrome 已装 opencli 扩展并启用
- 确认 Chrome 已登录 `www.taptap.cn`
- 有时需要重启 daemon：`opencli daemon restart`

### C3. `页面凭据不全（xsrf/uid 缺失）`

**现象**：发送时失败，日志提示凭据缺失。

**原因**：opencli `open` 只是**发起导航**，页面还没加载完时 `document.cookie` 是空的。

**做法**：代码里已有 `waitForCreds` 会等 15 秒。若仍失败：

1. 手动在浏览器打开 `https://www.taptap.cn/` 并确认已登录
2. 重试；仍不行就 `opencli daemon restart`
3. 确认登录的不是别的账号/无痕窗口

> 失败结果**不会被缓存**（故意的），所以下次调用会自动重试，不用重启进程。

### C4. 两个守护抢标签页

**原因**：`watch` 和 `mod-watch` 如果共用同一个 opencli session 会互相顶。

**做法**：确认配置里是两个不同会话：

```json
"reply": { "session": "tap" },
"modTasks": { "session": "tapmod" }
```

并按顺序启动：`OCR → watch → mod-watch`。

---

## D. 发送相关

### D1. 回复里出现两个 `@某人`

**状态**：**已于 2026-11-20 修复**。

原因（历史）：提示词让模型写 `@某人`，发送层又拼一次 → `@狐玖儿 @狐玖儿`。

现在有三道保险：

1. 提示词明确要求"正文里不要写 @" 
2. `sanitize` 剥掉开头所有 `@xxx`
3. 发送前 `assertSingleMention` 断言同名只出现一次

如果还看到双 @，说明改的是旧代码 —— 确认 `lib/compose-reply.mjs` 里有 `stripLeadingMention`。

### D2. 签名重复

`clampReply` 会检查 `s.includes(sig)`，已有就不再加。若仍重复，检查是不是模型自己写了签名（`sanitize` 会剥 `「版主助手-小鲸鱼」`）。

### D3. 回复发不出去 / 静默失败

按顺序查：

1. `reply.dryRun` 是不是 `true`（试运行只生成不发）
2. 日志里有没有 `[跳过] 草稿为空`（空正文会被拦）
3. 有没有 `[跳过] 幂等门`（这条回复记录为已发）
4. 有没有 `WAF_BLOCKED`（见 E1）
5. `node scripts/doctor.mjs` 看浏览器桥接

### D4. 答非所问 / 说"正文断了"

**状态**：**已于 2026-11-20 修复**。

原因：旧接口 `topic.summary` 硬截 **200 字**，长帖读不全。

现在走官方 CLI 的 `content`（实测同帖 954 字全文）。确认：

```bash
node scripts/collect.mjs --dry-run
# 日志里应有：[讨论] 官方 CLI：N 条一级 / M 条子回复
```

如果没有这行，说明走了降级（旧接口）—— 查 `taptapCli.enabled` 和 CLI 登录状态。

---

## E. 网络与风控

### E1. `WAF_BLOCKED` / 被阿里云 WAF 拦

**现象**：接口返回 200 但内容是 HTML，或 403/412。

**做法**：

1. 等一会（默认冷却 15 分钟，`watch.wafCooldownMinutes`）
2. 降低频率：
   ```json
   "exec": { "rateLimit": { "mode": "fixed", "perSecond": 0.17 } }
   ```
3. 确认 `exec.rateLimit.mode` 是 `adaptive`（默认）：它会在检出 WAF 时自动降速、连续失败硬刹车

**不要**靠频繁重试硬撞 —— 实测 IP 级封禁会长于 25 分钟。

### E2. 官方 CLI 报网络错

`taptap-cli status` 看服务是否可达。它走 `api.tapapis.cn`（不是 `www.taptap.cn`），代理规则要覆盖。

---

## F. 服务与模型

### F1. OCR 不可用

```bash
curl http://127.0.0.1:8790/health
python scripts/ocr_server.py --port 8790
```

没装 Python 包会启动失败：`pip install rapidocr-onnxruntime`。

### F2. `InvalidGraph: ... fp16 ... not supported`

**原因**：rerank 模型是 fp16 计算图，CPU 版 onnxruntime 不支持。

**做法**：

```bash
pip install "onnx==1.17.0"
python <skill>/work/fix-fp16-onnx.py
```

生成 fp32 的 `model_quantized.onnx`（原文件不动）。

### F3. rerank 一直超时

先确认模型加载成功（`/health` 里会报）。首次加载 1.5 GB 需要几秒，`rerank.timeoutMs` 默认 20 秒够用。

还是慢就把 `rerank.backend` 设 `off`，走 RRF。

### F4. embedding 连不上

```bash
ollama serve
ollama pull bge-m3
curl http://127.0.0.1:11434/api/tags
```

连不上会自动退 `char`（字符 n-gram），不影响运行。

---

## G. 配置

### G1. 改了配置没生效

配置**每次启动读一次**。改完要重启对应进程。

例外：`collect` 每轮会重读部分配置（如 rerank backend），但 `reply`/`exec` 这类需要重启。

### G2. 配置项写错导致行为异常

所有配置项都过 `schema.json` 校验。跑：

```bash
node scripts/config-doc.mjs      # 会列出「未在 schema 定义」的键
node scripts/doctor.mjs          # 会显示配置问题
```

校验**不阻断运行**（只警告），所以写错不会让守护停，但行为可能不符合预期 —— 看启动日志里的 `[配置] ⚠` 行。

### G3. 优先级搞不清

```
schema 默认值 < scripts/config.json < scripts/config.local.json < 环境变量
```

环境变量会让 `config.json` 里看着对的值失效。查一下：

```powershell
Get-ChildItem Env: | Where-Object { $_.Name -like 'TAPTAP_CFG_*' }
```

### G4. 旧键 `features.*` / `plugins.*` 还要不要留

**暂时留着**。启动时会自动迁移到新键（`xxx.enabled`）并打一行日志：

```
[配置] 旧键已迁移 5 项（保留旧键兼容；新键优先）：features.image→image.enabled, ...
```

等所有消费方改造完成才会删旧键。

---

## H. 守护

### H1. 守护起来就退出

看日志最后几行。常见：

- 配置缺 `myUserId` → `node scripts/whoami.mjs`
- 端口/单实例冲突（同一 skill 不能起两个 watch）
- 浏览器凭据失败 → 见 C3

### H2. 守护在跑但没回复

1. 队列积压？看日志有没有 `[队列]` 回填
2. 全部被判定"无需回复"？看 `reports/需人工清单-*.md`
3. `reply.dryRun` 是不是 true
4. LLM 额度用完了？看 `data/llm-usage.json` 和 `llm.dailyCallCap`
5. 时段原因：`match.minPostAgeMinutes`（默认 10 分钟）会让新帖等一会

### H3. 守护进程会随会话结束而死

这些进程是**当前终端/会话的子进程**，关掉终端或重启机器就没了。需要长期运行请自己用系统服务/计划任务托管。

启动顺序：`ocr_server → watch → mod-watch`。