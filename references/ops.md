# 部署与运维（Windows）

> 本 skill 自包含：答疑库、状态库、报表都在 skill 目录内，路径用 `{{SKILL}}` 占位跟着目录走。

## 0. 先搞清楚一件事：为什么不能做成「Windows 服务」

| | Windows 服务（NSSM / sc create） | 计划任务（用户登录时运行） |
|---|---|---|
| 运行会话 | **Session 0**（隔离，无桌面） | 用户的交互式会话 |
| 能否操作 Chrome | **不能** —— 看不到你桌面上的浏览器 | 能 |
| 结论 | ❌ 对本工具不可用 | ✅ 正确做法 |

本工具的回复**完全依赖操作一个真实的、已登录 TapTap 的 Chrome**。
Windows 服务跑在 Session 0，既看不到桌面，也连不上你浏览器里的登录态。
所以「常驻」的正解是：**计划任务 + 登录时启动 + 崩溃自动重启**。

代价（必须接受）：**机器要保持登录状态**。锁屏可以，注销/关机/重启后没人登录就不跑。

## 1. 一次性准备

```powershell
opencli doctor                              # 扩展要 connected
node scripts\whoami.mjs                     # 拿 user_id → 填 scripts\config.json 的 myUserId
```

确认 `config.json`：

```json
"myUserId": "你的id",
"reply": { "dryRun": false }
```

## 2. 三种运行方式

| 方式 | 适用 | 命令 |
|---|---|---|
| **A. 计划任务**（推荐，可无人值守） | 长期挂着 | 见第 3 节 |
| **B. 前台窗口** | 调试/短期 | `node scripts\watch.mjs`（Ctrl+C 停） |
| **C. Windows 服务** | ❌ 不可用 | 见第 0 节 |

## 3. 计划任务（推荐方案）

脚本 `scripts/schedule.ps1` 一把梭：

```powershell
cd $env:USERPROFILE\.dsh\skills\taptap-pvz2-forum-moderator

# 安装（登录后 2 分钟启动；崩溃每 1 分钟重启，最多 999 次；不限单次运行时长）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\schedule.ps1 -Action install

# 自检（node / myUserId / opencli / 任务状态 / 进程 / 日志）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\schedule.ps1 -Action doctor

# 立即试跑一次
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\schedule.ps1 -Action start

# 只管当前状态
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\schedule.ps1 -Action status

# 停 / 卸载（不动答疑库和状态库）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\schedule.ps1 -Action stop
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\schedule.ps1 -Action uninstall
```

安装时做了这些事：

- 把 `node.exe` 绝对路径写进 `scripts\node-path.txt`（计划任务的环境变量可能不完整）
- 任务动作 = `cmd.exe /c "<skill>\scripts\run-watch.cmd"`（启动器负责切目录、写日志、轮转、记退出码）
- 触发器 = **AtLogOn**（当前用户）+ 延迟 2 分钟（等 Chrome / opencli daemon 起来）
- 设置 = `MultipleInstances IgnoreNew`（**绝不并发多开**）、崩溃重启、无运行时长上限
- 主体 = 当前用户、`LogonType Interactive`、`RunLevel Limited`（不需要管理员常驻）

参数可调：`-DelayMinutes 5 -RestartCount 20 -RestartMinutes 2 -TaskName "我的任务名"`。

## 4. 真正无人值守（可选）

要点：**开机后必须有人登录到桌面**，计划任务才会触发。

1. 设置 → 账户 → 登录选项 → 关闭「需要登录」，或用 [Autologon](https://learn.microsoft.com/sysinternals/downloads/autologon)
2. 登录后自动锁屏也行（锁屏不会断开桌面会话）
3. 电源设置：**禁止睡眠 / 休眠**，否则网络和浏览器都会断
   ```powershell
   powercfg /change standby-timeout-ac 0
   powercfg /change hibernate-timeout-ac 0
   ```
4. 远程桌面断开时注意别把会话弄锁死，必要时用 `tscon` 保持会话

## 5. 日志与状态

| 内容 | 位置 |
|---|---|
| 运行日志（计划任务写入） | `logs\watch.log`（超过 5MB 自动轮转为 `watch.log.1`） |
| 每轮摘要 | `data\state.json` 的 `runs` 数组（保留最近 199 轮） |
| 人看的报表 | `reports\questions.md` |
| Excel 报表 | `reports\questions.csv`（带 UTF-8 BOM） |
| 已发文本记录（防重复） | `data\state.json` 的 `recentReplies` |

> 注意：在 DSH 会话里用后台任务跑 watch 时，输出进的是任务输出而不是 `logs\watch.log`；
> 只有走计划任务（`run-watch.cmd`）才会有日志文件。

## 6. 分发清单

打包给同事时：

**要带**：`SKILL.md`、`scripts/`、`references/`、`assets/`、`qa/答疑库.md`
**不要带**：`data/`、`reports/`、`logs/`、`scripts/node-path.txt`、`qa/答疑库.md.backup.md`、`qa/答疑库.md.before-*`、`qa/答疑库.md.before-purge-*`、`qa/归档/`

> `scripts/` 里包含两个管理 CLI（`qa-admin.mjs` / `post-admin.mjs`）、DOM 探针（`probe-dom.mjs`）、
> 七套回归测试，以及部署脚本（`schedule.ps1` / `run-watch.cmd`）—— 都随 skill 走，别人拿到就能用。
> 用法见 `references/admin.md`。

> ⚠️ **答疑库的方向永远是「运行中的那份 → 构建源 / 留档」，不能反着来。**
> 运行中的 `qa/答疑库.md` 会被守护进程持续沉淀（一天能长十几条），
> 它才是权威版本；构建源那份只是快照。反向覆盖过一次，一夜沉淀的 10 条全丢（已重建找回）。
>
> 兜底：每轮开始会自动备份到 `qa/答疑库.md.backup.md`，
> 真出事了 `node scripts\restore-qa.mjs --restore` 一条命令回退。

```powershell
$s = "$env:USERPROFILE\.dsh\skills\taptap-pvz2-forum-moderator"
robocopy $s "$env:TEMP\pvz2-share\taptap-pvz2-forum-moderator" /E `
  /XD data reports logs /XF node-path.txt
Compress-Archive "$env:TEMP\pvz2-share\taptap-pvz2-forum-moderator" `
  -DestinationPath .\taptap-pvz2-forum-moderator.zip -Force
```

对方拿到后的步骤：

1. 解压到 `%USERPROFILE%\.dsh\skills\taptap-pvz2-forum-moderator\`
2. `npm i -g @jackwener/opencli`，装浏览器扩展，登录 www.taptap.cn
3. `node scripts\whoami.mjs` → 把 id 填进 `scripts\config.json` 的 `myUserId`
4. 三套自检：`node scripts\test-question.mjs` / `test-praise.mjs` / `test-variants.mjs`
5. `node scripts\watch.mjs --dry-run` 看一轮效果
6. `reply.dryRun` 改 `false`，再 `schedule.ps1 -Action install`

## 7. ⚠️ 多人使用必须守的规矩

**每个人的 `data/state.json` 是独立的** —— 这既是优点也是坑：

| 事实 | 后果 |
|---|---|
| A 回过哪些帖，B 完全不知道 | **同一个问题会被多人各回一遍** |
| 各自 `myUserId` 不同 | 互相之间判定不出「我已经回过了」 |
| 答疑库若各改一份 | 同问题答案口径不一致 |

所以：

1. **只有一个账号开自动回复**（负责日常答疑的那个人），其他人两种选择：
   - 用 `node scripts\watch.mjs --no-reply` —— 只采集 + 出报表，不发言
   - 干脆不跑，直接用主号出的 `reports\questions.md`
2. **答疑库只维护一份**，由主号负责人统一改，其他人拉最新版覆盖
3. 实在要多人同时回：必须**人工排班**（谁在几点开、其他人先 `-Action stop`），
   代码层面没有跨机锁，做不到自动避让
4. 同一台机器上**绝对不要同时跑两个 watch**（`schedule.ps1 -Action status` 会检测并告警）

## 8. 换到别的游戏

1. 找 `group_id`：打开 `https://www.taptap.cn/app/<appId>/topic`，在 HTML 里搜 `group_id=`
2. 改 `scripts\config.json` 的 `appId / groupId / appName / forumUrl`
3. 换一份 `qa/答疑库.md`
4. 代码不用动

## 9. 排障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `被 WAF 拦截，本轮跳过` | IP 被限流 | 等 20~30 分钟，**别重启刷** |
| `opencli 扩展未连接` | 扩展断开 | `opencli daemon restart` |
| 任务显示「正在运行」但不回复 | Chrome 没登录 / 会话锁了 | 看 `logs\watch.log`，确认桌面会话在 |
| 机器重启后不跑 | 没人登录到桌面 | 见第 4 节（自动登录 + 禁止睡眠） |
| 重复回复同一帖 | 多开 / 没填 myUserId / 多人同跑 | `-Action status` 查进程数；看第 7 节 |
| 日志文件不存在 | 不是用计划任务跑的 | 用 `run-watch.cmd` 或计划任务启动 |
| 报表空 | 接口没通 | `node scripts\fetch-latest.mjs` 单独验证 |
| 状态越积越多 | 正常 | `state.json` 是累积的，删了会丢失去重基线 |

## 10. 风险控制

- `reply.dryRun` 默认 `true`，确认后再改 `false`
- `maxAutoReplyPerRun` 默认 8，防刷屏
- `blacklistWords` 命中强制转人工（充值/申诉/封号等）
- `minPostAgeMinutes` 默认 10，新帖冷却
- `praise.maxPerRun` 默认 3，单轮最多夸 3 条
- 每条回复带 `reply.signature`（「版主助手-小鲸鱼」），既是署名也是机器特征，酌情调整
