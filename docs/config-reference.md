# 配置参考

> ⚠️ **本文件由 `node scripts/config-doc.mjs` 从 `scripts/config/schema.json` 自动生成，不要手改。**
> 要改默认值或加配置项 → 改 `schema.json` → 重跑生成脚本。

## 怎么用

**优先级（后者覆盖前者）：**

```
schema 默认值  <  scripts/config.json  <  scripts/config.local.json  <  环境变量
```

- `scripts/config.json` —— 团队共享配置（入库）
- `scripts/config.local.json` —— 个人覆盖（**不入库**，深合并进去）
- 环境变量 —— `TAPTAP_CFG_<分组>_<字段>`，分组与字段转大写、点换下划线。
  例：`TAPTAP_CFG_REPLY_MAXCHARS_POST=200`、`TAPTAP_CFG_EXEC_WORKERPOOL_ENABLED=true`

**每个功能只有一个 `enabled`**，放在该功能自己的分组下。旧键（`features.*` / `plugins.*`）启动时会自动迁移：
新键写入，**旧键暂时保留兼容**（等所有消费方改造完才删）。迁移清单会打一行日志，不静默。

**校验失败不阻断运行** —— 配置项写错只打警告，守护不会因此停摆。

## 字段总览（共 173 项）

| 分组 | 键 | 类型 | 默认 | 范围 | 说明 |
|---|---|---|---|---|---|
| 基础 | `appId` | `integer` | `54031` | — | TapTap 游戏 ID（PVZ2 = 54031） |
| 基础 | `groupId` | `integer` | `40173` | — | 论坛板块 ID |
| 基础 | `appName` | `string` | `"植物大战僵尸2"` | — | 游戏名 |
| 基础 | `forumUrl` | `string` | `"https://www.taptap.cn/app/54031/topic"` | — | 论坛地址 |
| 基础 | `myUserId` | `string` | *(空)* | — | bot 自己的 TapTap 用户 ID，用于识别「哪些回复是我们发的」。用 node scripts/whoami.mjs 获取 |
| 基础 | `teamUserIds` | `array` | `[]` | — | 多人协作时，队友发的回复也算「我们这边」 |
| 基础 | `pipeline` | `v1 | v2` | `"v2"` | — | v1 = 旧的纯语义匹配；v2 = facts 优先检索 + 分档验证 |
| 回复方式 | `reply.channel` | `opencli` | `"opencli"` | — | 发送通道 |
| 回复方式 | `reply.session` | `string` | `"tap"` | — | 浏览器会话标识，和 mod-watch 的 tapmod 分开，避免抢标签页 |
| 回复方式 | `reply.via` | `api | ui` | `"api"` | — | api = 页面内 fetch（快，约1s）；ui = 点按钮填编辑器（慢，5~15s） |
| 回复方式 | `reply.nestedVia` | `api | ui` | `"api"` | — | 楼中楼走法 |
| 回复方式 | `reply.signature` | `string` | `"「版主助手-小鲸鱼」"` | — | 由脚本统一追加一次，模型不许自己写 |
| 回复方式 | `reply.delayMs` | `integer` | `6000` | ≥ 0，≤ 600000 | 已废弃：限速改由 exec.rateLimit 统一管 |
| 回复方式 | `reply.apiIntervalMs` | `integer` | `0` | ≥ 0，≤ 60000 | 每次接口调用之间的最小间隔。0 = 不节流（2026-11-20 起默认放开，只在检出 WAF 时由 exec.rateLimit 自适应降速） |
| 回复方式 | `reply.maxChars` | `object` | `{"post":130,"nested":70}` | — | post = 一级回复；nested = 楼中楼。平台硬上限 1000，这里只是「说短点」的软限制 |
| 回复方式 | `reply.dryRun` | `boolean` | `false` | — | true = 只生成不发 |
| 回复方式 | `reply.refuseOnUnknown` | `boolean` | `false` | — | 不确定时婉拒 |
| 回复方式 | `reply.blacklistWords` | `array` | `["客服","申诉","退款","充值失败","封号","举报","官方补偿","版号"]` | — | 命中这些词的帖子不自动回复，转人工 |
| 执行调度 | `exec.concurrency` | `integer` | `1` | ≥ 1，≤ 32 | 单队列模式下的并发上限。多队列模式下各队列独立配置 |
| 执行调度 | `exec.maxQueues` | `integer` | `32` | ≥ 1，≤ 128 | 队列数不设硬上限（3 不是终点）：perPlugin 模式下每个插件一条，perPost 模式下每帖一条 |
| 执行调度 | `exec.rateLimit.mode` | `off | fixed | adaptive` | `"adaptive"` | — | off = 不限速；fixed = 用 perSecond（旧行为）；adaptive = 默认全速，检出 WAF 才退避（推荐） |
| 执行调度 | `exec.rateLimit.perSecond` | `number` | `0` | ≥ 0，≤ 100 | 仅 mode=fixed 时生效。0 = 不限。旧的 0.17（≈1000/6000）实际把吞吐压到 6 秒/条 |
| 执行调度 | `exec.rateLimit.waf.cooldownMs` | `integer` | `60000` | ≥ 1000，≤ 3600000 | adaptive 模式下检出 WAF 后的降速冷却时间 |
| 执行调度 | `exec.rateLimit.waf.recoverEvery` | `integer` | `20` | ≥ 1，≤ 1000 | 每成功 N 次尝试提速一次 |
| 执行调度 | `exec.rateLimit.waf.recoverFactor` | `number` | `1.5` | ≥ 1，≤ 10 | 提速倍数 |
| 执行调度 | `exec.rateLimit.waf.hardBrakeAfter` | `integer` | `3` | ≥ 1，≤ 100 | 连续 N 次 WAF → 暂停所有发送 |
| 执行调度 | `exec.rateLimit.waf.pauseMinutes` | `integer` | `15` | ≥ 1，≤ 1440 | 硬刹车时长(分钟) |
| 执行调度 | `exec.workerPool.enabled` | `boolean` | `false` | — | worker_threads 真并行（实测 3 线程 2.97x）。硬约束：worker 只发送，记账归父进程 |
| 执行调度 | `exec.workerPool.size` | `integer` | `4` | ≥ 1，≤ 32 | 线程数 |
| 执行调度 | `exec.workerPool.taskTimeoutMs` | `integer` | `120000` | ≥ 1000，≤ 1800000 | 超时 → terminate 该线程并补一个 |
| 执行调度 | `exec.queues.mode` | `fixed | perPlugin | perPost` | `"fixed"` | — | fixed = answer/social/summon 三条（旧行为）；perPlugin = 每个插件一条（互不阻塞）；perPost = 每帖一条（上限 maxQueues） |
| 官方 CLI 通道 | `taptapCli.enabled` | `boolean` | `true` | — | 关闭则退回旧接口（会丢失全文与全子回复） |
| 官方 CLI 通道 | `taptapCli.binary` | `string` | `"taptap-cli"` | — | npm i -g @taptap/cli 安装后的命令名 |
| 官方 CLI 通道 | `taptapCli.developerId` | `integer` | `1` | — | 官方 CLI 要求必填整数；实测读接口不校验归属。等真实 dev_id 下来再换 |
| 官方 CLI 通道 | `taptapCli.writeEnabled` | `boolean` | `false` | — | 写接口需要「论坛主管理员」权限（普通版主 403，换 token 无效）。权限到位后再打开；现在写走页面内 fetch |
| 官方 CLI 通道 | `taptapCli.fallbackToOpencli` | `boolean` | `true` | — | true = CLI 挂了自动回退，绝不因为 CLI 不可用就不回复玩家。**建议永远保持 true** |
| 官方 CLI 通道 | `taptapCli.timeoutMs` | `integer` | `30000` | ≥ 1000，≤ 600000 | 单次超时(ms) |
| 采集 | `collect.sort` | `created | commented` | `"created"` | — | 排序 |
| 采集 | `collect.type` | `string` | `"feed"` | — | 列表类型 |
| 采集 | `collect.commentDelayMs` | `integer` | `1500` | ≥ 0，≤ 60000 | 评论请求间隔(ms) |
| 采集 | `collect.commentPageSize` | `integer` | `30` | ≥ 1，≤ 100 | 旧接口的页大小。以前写死 30 |
| 采集 | `collect.commentMaxPages` | `integer` | `8` | ≥ 1，≤ 50 | 防失控上限 |
| 采集 | `collect.childPageSize` | `integer` | `50` | ≥ 1，≤ 100 | 官方 CLI 的 child-replies 页大小 |
| 匹配阈值 | `match.autoReplyScore` | `number` | `0.65` | ≥ 0，≤ 1 | 相似度达到这个分才自动回 |
| 匹配阈值 | `match.suggestScore` | `number` | `0.45` | ≥ 0，≤ 1 | 低于自动阈值但高于这个 → 出草稿给人工 |
| 匹配阈值 | `match.maxAutoReplyPerRun` | `integer` | `8` | ≥ 1，≤ 100 | 只对「手动 collect」生效；守望队列模式每轮只处理 1 条 |
| 匹配阈值 | `match.minPostAgeMinutes` | `integer` | `10` | ≥ 0，≤ 1440 | 太新的帖子先不抢答，给其他玩家机会 |
| 图片识别 | `image.enabled` | `boolean` | `true` | — | 启用 |
| 图片识别 | `image.skipIntents` | `array` | `["friendCode","tiangongCode"]` | — | 求码/好友码帖不识别图片 |
| 图片识别 | `image.bareCodeIsIntent` | `boolean` | `true` | — | 裸码也算求码 |
| 图片识别 | `image.ocr.enabled` | `boolean` | `true` | — | 需要 python scripts/ocr_server.py（端口 8790） |
| 图片识别 | `image.vision.enabled` | `boolean` | `true` | — | VLM 启用 |
| 图片识别 | `image.features.enabled` | `boolean` | `true` | — | 模板匹配启用 |
| 夸奖通道 | `praise.enabled` | `boolean` | `true` | — | 提问帖里已有好答案 → 在那条评论下盖楼夸一句 |
| 夸奖通道 | `praise.signature` | `boolean` | `true` | — | 带签名 |
| 夸奖通道 | `praise.minScore` | `integer` | `1` | ≥ 1，≤ 10 | 最低有效分 |
| 夸奖通道 | `praise.maxPerRun` | `integer` | `3` | ≥ 1，≤ 50 | 单轮上限 |
| 分享互动 | `share.enabled` | `boolean` | `true` | — | 分享/记录/进度帖 → 去说一句鼓励，不答疑不评价数值 |
| 分享互动 | `share.signature` | `boolean` | `true` | — | 带签名 |
| 分享互动 | `share.maxPerRun` | `integer` | `2` | ≥ 1，≤ 50 | 单轮上限 |
| 情绪陪伴 | `comfort.enabled` | `boolean` | `true` | — | 纯情绪帖（绝了/可惜/憋屈）→ 陪一句共情，一帖一次 |
| 情绪陪伴 | `comfort.signature` | `boolean` | `true` | — | 带签名 |
| 情绪陪伴 | `comfort.maxPerRun` | `integer` | `2` | ≥ 1，≤ 50 | 单轮上限 |
| 互动续聊 | `interact.enabled` | `boolean` | `true` | — | 玩家回应了我们 → 接一句 |
| 互动续聊 | `interact.maxPerPost` | `integer` | `1` | ≥ 1，≤ 20 | 单帖上限 |
| 互动续聊 | `interact.maxPerRun` | `integer` | `3` | ≥ 1，≤ 50 | 单轮上限 |
| 互动续聊 | `interact.samePlayerLimit` | `integer` | `1` | ≥ 1，≤ 20 | 同玩家免降级次数 |
| 互动续聊 | `interact.probabilityAfterLimit` | `number` | `0.5` | ≥ 0，≤ 1 | 超限后回复概率 |
| 互动续聊 | `interact.strongTextLen` | `integer` | `40` | ≥ 1，≤ 500 | 正文长度达到这个值 → 不受概率限制，必回 |
| 互动续聊 | `interact.revisitRepliedPosts` | `boolean` | `true` | — | T30：**定期重读我们回过的帖**，看玩家有没有新回复。只靠通知会漏（@ 当时是纯文本不触发通知）→ 玩家回了我们却不知道（帖 872166231715613408 实例） |
| 互动续聊 | `interact.revisitDays` | `integer` | `3` | ≥ 1，≤ 30 | 只回访最近 N 天内我们回过的帖 |
| 互动续聊 | `interact.revisitEveryMinutes` | `integer` | `30` | ≥ 1，≤ 1440 | 同一帖最少隔多久回访一次（用 post_event 的 revisit 事件记账） |
| 互动续聊 | `interact.revisitLimit` | `integer` | `10` | ≥ 1，≤ 100 | 每轮最多回访几个帖（按我们最后回复时间倒序） |
| 喊话通道 | `summon.enabled` | `boolean` | `true` | — | 玩家 @ 我们/喊别名 → 应一声 |
| 喊话通道 | `summon.aliases` | `array` | `["大肥鱼","胖鱼","吃白米饭的"]` | — | 其它别名 |
| 喊话通道 | `summon.matchRoles` | `boolean` | `true` | — | 匹配版主语气 |
| 喊话通道 | `summon.signature` | `boolean` | `true` | — | 带签名 |
| 喊话通道 | `summon.answerFromQa` | `boolean` | `true` | — | 允许用答疑库作答 |
| 喊话通道 | `summon.qaScore` | `number` | `0.6` | ≥ 0，≤ 1 | 喊话场景匹配阈值 |
| 喊话通道 | `summon.maxPerRun` | `integer` | `3` | ≥ 1，≤ 50 | 单轮上限 |
| 喊话通道 | `summon.maxPerPost` | `integer` | `1` | ≥ 1，≤ 20 | 单帖上限 |
| 天宫码撮合 | `codeMatch.enabled` | `boolean` | `false` | — | 有人贴码 → 把帖链接发给求码的人（只转达，不担保码有效）。⚠️ 键名是 codeMatch（大写 M），与 config.json 一致，勿改成小写 |
| 天宫码撮合 | `codeMatch.shareWindowMinutes` | `integer` | `5` | ≥ 1，≤ 1440 | 发码窗口(分钟) |
| 天宫码撮合 | `codeMatch.askWindowMinutes` | `integer` | `120` | ≥ 1，≤ 2880 | 求码窗口(分钟) |
| 天宫码撮合 | `codeMatch.maxAskersPerShare` | `integer` | `3` | ≥ 1，≤ 50 | 每帖最多通知几人 |
| 天宫码撮合 | `codeMatch.maxSharesPerAsker` | `integer` | `1` | ≥ 1，≤ 20 | 每个求码者最多被通知几次 |
| 天宫码撮合 | `codeMatch.templates.enabled` | `boolean` | `true` | — | 启用文案模板池 |
| 天宫码撮合 | `codeMatch.templates.minTemplates` | `integer` | `4` | ≥ 1，≤ 50 | 低于此数量就补 |
| 天宫码撮合 | `codeMatch.templates.targetTemplates` | `integer` | `8` | ≥ 1，≤ 100 | 补到多少条 |
| 天宫码撮合 | `codeMatch.templates.maxAgeHours` | `integer` | `24` | ≥ 1，≤ 720 | 模板最长寿命(小时) |
| 评论分析 | `comment.enabled` | `boolean` | `true` | — | 用规则识别「反对/纠错」与「补充」→ 写 data/comment-analysis.jsonl。**只分析不发送** |
| 周报 | `weekly.enabled` | `boolean` | `true` | — | 每周生成运营周报，数据全部来自本地 trace/usage，不调外部接口 |
| 周报 | `weekly.everyDays` | `integer` | `7` | ≥ 1，≤ 90 | 间隔天数 |
| 周报 | `weekly.days` | `integer` | `7` | ≥ 1，≤ 90 | 统计窗口天数 |
| 增量摄入 | `ingest.enabled` | `boolean` | `false` | — | 默认关闭（避免自动摄入噪声）。填了官方 url 或开启 weekly 源后才建议打开 |
| 增量摄入 | `ingest.sources.official.enabled` | `boolean` | `false` | — | 官方公告源 |
| 增量摄入 | `ingest.sources.official.urls` | `array` | `[]` | — | 官方公告 URL 列表 |
| 增量摄入 | `ingest.sources.weekly.enabled` | `boolean` | `false` | — | 周报 md 源 |
| 评价分析 | `review.enabled` | `boolean` | `false` | — | **只读分析，绝不自动回复评价**（评价处置归人工） |
| 评价分析 | `review.autoAnalyze` | `boolean` | `false` | — | 自动分析 |
| 评价分析 | `review.lowScoreMax` | `integer` | `2` | ≥ 1，≤ 5 | 低分阈值 |
| 管理任务 | `modTasks.enabled` | `boolean` | `true` | — | 常驻 mod-watch：好友码帖识别与回复。**删除动作永不自动执行** |
| 管理任务 | `modTasks.intervalSeconds` | `integer` | `120` | ≥ 30，≤ 3600 | 轮询间隔(秒) |
| 管理任务 | `modTasks.session` | `string` | `"tapmod"` | — | opencli 会话名 |
| 归档 | `archive.enabled` | `boolean` | `true` | — | 每天整理一次：答疑库冷数据 + 帖子冷热分离 |
| 归档 | `archive.staleDays` | `integer` | `30` | ≥ 1，≤ 365 | 冷数据天数 |
| 归档 | `archive.keepStatePosts` | `integer` | `300` | ≥ 50，≤ 5000 | state 保留帖子数 |
| 归档 | `archive.olderThanDays` | `integer` | `30` | ≥ 1，≤ 365 | 帖子冷归档天数 |
| 答疑库体检 | `qaHealth.enabled` | `boolean` | `true` | — | 启用 |
| 答疑库体检 | `qaHealth.everyHours` | `integer` | `24` | ≥ 1，≤ 720 | 间隔小时 |
| 答疑库体检 | `qaHealth.autoPurge` | `boolean` | `true` | — | 正文里带我们签名（不该出现在库里）→ 移到归档。只移动不删除 |
| 答疑库自治治理 | `qaGovern.enabled` | `boolean` | `true` | — | 启用 |
| 答疑库自治治理 | `qaGovern.auto` | `boolean` | `true` | — | true = 直接改库并可回滚；false = 只出报告 |
| 答疑库自治治理 | `qaGovern.dedupThreshold` | `number` | `0.94` | ≥ 0.5，≤ 1 | 包含度达到这个值判为重复 |
| 答疑库自治治理 | `qaGovern.neverCitedDays` | `integer` | `45` | ≥ 1，≤ 365 | 零引用归档天数 |
| 检索 | `retrieve.topK` | `integer` | `8` | ≥ 1，≤ 50 | 召回条数 |
| 检索 | `retrieve.minScore` | `number` | `0.2` | ≥ 0，≤ 1 | 最低分 |
| 检索 | `retrieve.rerank` | `boolean` | `true` | — | 启用重排 |
| 检索 | `retrieve.denseBackend` | `bge | char` | `"bge"` | — | bge = Ollama bge-m3（更准，需 ollama serve）；char = 字符 n-gram（零依赖兜底） |
| 检索 | `retrieve.embedModel` | `string` | `"bge-m3"` | — | embedding 模型 |
| 检索 | `retrieve.embedEndpoint` | `string` | `"http://127.0.0.1:11434"` | — | embedding 服务地址 |
| 检索 | `retrieve.maxMaterialChars` | `integer` | `1000` | ≥ 100，≤ 10000 | 资料块预算(字符) |
| 重排模型 | `rerank.backend` | `onnx | llm | off` | `"onnx"` | — | 后端 |
| 重排模型 | `rerank.server` | `string` | `"http://127.0.0.1:8790"` | — | 由 scripts/ocr_server.py 提供 /rerank |
| 重排模型 | `rerank.modelDir` | `string` | `"E:\\Ollama\\models\\bge-reranker-v2-m3"` | — | 需手动放置，agent 不会自动下载 |
| 重排模型 | `rerank.timeoutMs` | `integer` | `20000` | ≥ 1000，≤ 300000 | 超时(ms) |
| 大模型 | `llm.enabled` | `boolean` | `true` | — | 启用 |
| 大模型 | `llm.reuseDsh` | `boolean` | `true` | — | true = 跟随 GUI 里选的模型，不用自己填 key |
| 大模型 | `llm.apiKey` | `string` | *(空)* | — | reuseDsh=false 时才需要 |
| 大模型 | `llm.baseURL` | `string` | *(空)* | — | Base URL |
| 大模型 | `llm.model` | `string` | *(空)* | — | 模型名 |
| 大模型 | `llm.dailyCallCap` | `integer` | `300` | ≥ 0，≤ 100000 | 0 = 不限。超闸后快速失败转人工，不硬编 |
| 大模型 | `llm.usagePersist` | `boolean` | `true` | — | 调用计数落盘 |
| 大模型 | `llm.temperature` | `number` | `0.85` | ≥ 0，≤ 2 | 温度 |
| 大模型 | `llm.maxTokens` | `integer` | `600` | ≥ 50，≤ 8000 | 最大输出 token |
| 结构化追踪 | `trace.enabled` | `boolean` | `true` | — | 每帖 verdict/gen/sent 事件写 reports/trace-<date>.jsonl |
| 结构化追踪 | `trace.keepDays` | `integer` | `14` | ≥ 1，≤ 365 | 保留天数 |
| 周度评测 | `evalWeekly.enabled` | `boolean` | `true` | — | 每周一次**规则模式**评测（零 LLM 成本） |
| 周度评测 | `evalWeekly.everyDays` | `integer` | `7` | ≥ 1，≤ 90 | 间隔天数 |
| 弃答回收 | `evalCandidates.enabled` | `boolean` | `true` | — | C7 弃答的帖记 data/eval-candidates.jsonl，供后续补知识 |
| 渠道健康 | `llmHealth.enabled` | `boolean` | `true` | — | 启用 |
| 渠道健康 | `llmHealth.baseCooldownMs` | `integer` | `120000` | ≥ 1000，≤ 3600000 | 基础冷却(ms) |
| 渠道健康 | `llmHealth.maxCooldownMs` | `integer` | `1800000` | ≥ 1000，≤ 86400000 | 最大冷却(ms) |
| 渠道健康 | `llmHealth.smallTaskPreferOpenai` | `boolean` | `true` | — | 小任务优先 openai 风格渠道 |
| 场景负反馈 | `sceneFeedback.enabled` | `boolean` | `true` | — | 玩家反感某类行为时，跨帖收敛这一类 |
| 场景负反馈 | `sceneFeedback.cooldownMinutes` | `integer` | `60` | ≥ 1，≤ 10080 | 冷却分钟 |
| 场景负反馈 | `sceneFeedback.downgradedProb` | `number` | `0.25` | ≥ 0，≤ 1 | 降权后概率 |
| 场景负反馈 | `sceneFeedback.halfLifeHours` | `integer` | `24` | ≥ 1，≤ 720 | 半衰期(小时) |
| 场景负反馈 | `sceneFeedback.skipMinutes` | `integer` | `60` | ≥ 1，≤ 10080 | 跳过分钟 |
| 刷屏自审 | `spamStop.enabled` | `boolean` | `true` | — | 自查我们在这帖回了几条、几条同样含义 → 认错 + 停掉凑热闹类 |
| 刷屏自审 | `spamStop.dupSim` | `number` | `0.3` | ≥ 0，≤ 1 | 同样含义阈值 |
| 刷屏自审 | `spamStop.minDup` | `integer` | `2` | ≥ 1，≤ 20 | 最少重复条数 |
| 刷屏自审 | `spamStop.proactiveMax` | `integer` | `3` | ≥ 1，≤ 50 | 预防性上限 |
| 刷屏自审 | `spamStop.globalMinutes` | `integer` | `30` | ≥ 1，≤ 10080 | 全局冷静分钟 |
| 验证 | `verify.cacheTtlHours` | `integer` | `24` | ≥ 1，≤ 720 | 判定缓存 TTL(小时) |
| 验证 | `verify.postCheck` | `boolean` | `true` | — | 生成后忠实度自检 |
| 联网补答 | `websearch.enabled` | `boolean` | `true` | — | 答疑库没命中时联网搜一次，按 50% 置信度作答。依赖 baidu-websearch skill |
| 联网补答 | `websearch.timeoutMs` | `integer` | `60000` | ≥ 1000，≤ 300000 | 超时(ms) |
| 守护循环 | `watch.intervalSeconds` | `integer` | `120` | ≥ 30，≤ 3600 | 轮询间隔(秒) |
| 守护循环 | `watch.minOpGapMs` | `integer` | `300` | ≥ 0，≤ 60000 | 操作最小间隔(ms) |
| 守护循环 | `watch.wafCooldownMinutes` | `integer` | `15` | ≥ 1，≤ 1440 | WAF 冷却分钟 |
| 文件路径（内部） | `paths.dataDir` | `string` | `"{{SKILL}}/data"` | — | 数据目录 |
| 文件路径（内部） | `paths.qaFile` | `string` | `"{{SKILL}}/qa/答疑库.md"` | — | 答疑库文件 |
| 文件路径（内部） | `paths.usageFile` | `string` | `"{{SKILL}}/data/qa-usage.json"` | — | 引用统计 |
| 文件路径（内部） | `paths.archiveDir` | `string` | `"{{SKILL}}/qa/归档"` | — | 归档目录 |
| 文件路径（内部） | `paths.stateFile` | `string` | `"{{SKILL}}/data/state.json"` | — | 守护状态 |
| 文件路径（内部） | `paths.modStateFile` | `string` | `"{{SKILL}}/data/mod-state.json"` | — | 管理任务状态 |
| 文件路径（内部） | `paths.reportsDir` | `string` | `"{{SKILL}}/reports"` | — | 报告目录 |
| 文件路径（内部） | `paths.qaIndexFile` | `string` | `"{{SKILL}}/data/qa-index.sqlite"` | — | 答疑库索引 |
| 文件路径（内部） | `paths.postDbFile` | `string` | `"{{SKILL}}/data/post-records.sqlite"` | — | 帖子记录库 |
| 答疑库检索 | `qa.vector.backend` | `char | http` | `"char"` | — | char = 字符 n-gram TF-IDF（零依赖）；http = 接本地 embeddings 服务，失败自动退回 char |
| 答疑库检索 | `qa.vector.endpoint` | `string` | *(空)* | — | 向量服务地址 |
| 答疑库检索 | `qa.vector.model` | `string` | *(空)* | — | 向量模型名 |

## 分组说明

### 基础（顶层字段）

config.json 的**顶层**标量（这一组的字段不带前缀，直接就是顶层键）

- **`appId`** — App ID
  TapTap 游戏 ID（PVZ2 = 54031）
  默认 `54031`
- **`groupId`** — 论坛板块 ID
  默认 `40173`
- **`appName`** — 游戏名
  默认 `"植物大战僵尸2"`
- **`forumUrl`** — 论坛地址
  默认 `"https://www.taptap.cn/app/54031/topic"`
- **`myUserId`** — 我的 user_id
  bot 自己的 TapTap 用户 ID，用于识别「哪些回复是我们发的」。用 node scripts/whoami.mjs 获取
  默认 `""`
- **`teamUserIds`** — 队友 user_id 列表
  多人协作时，队友发的回复也算「我们这边」
  默认 `[]`
- **`pipeline`** — 管线版本
  v1 = 旧的纯语义匹配；v2 = facts 优先检索 + 分档验证
  默认 `"v2"`，取值 v1 / v2

### 回复方式 · `reply`

怎么把回复发出去、发多长、带什么签名

- **`reply.channel`** — 发送通道
  默认 `"opencli"`，取值 opencli
- **`reply.session`** — opencli 会话名
  浏览器会话标识，和 mod-watch 的 tapmod 分开，避免抢标签页
  默认 `"tap"`
- **`reply.via`** — 一级回复走法
  api = 页面内 fetch（快，约1s）；ui = 点按钮填编辑器（慢，5~15s）
  默认 `"api"`，取值 api / ui
- **`reply.nestedVia`** — 楼中楼走法
  默认 `"api"`，取值 api / ui
- **`reply.signature`** — 签名
  由脚本统一追加一次，模型不许自己写
  默认 `"「版主助手-小鲸鱼」"`
- **`reply.delayMs`** — 发送间隔(ms)
  已废弃：限速改由 exec.rateLimit 统一管
  默认 `6000`
- **`reply.apiIntervalMs`** — 接口调用间隔(ms)
  每次接口调用之间的最小间隔。0 = 不节流（2026-11-20 起默认放开，只在检出 WAF 时由 exec.rateLimit 自适应降速）
  默认 `0`
- **`reply.maxChars`** — 回复字数上限
  post = 一级回复；nested = 楼中楼。平台硬上限 1000，这里只是「说短点」的软限制
  默认 `{"post":130,"nested":70}`
- **`reply.dryRun`** — 试运行
  true = 只生成不发
  默认 `false`
- **`reply.refuseOnUnknown`** — 不确定时婉拒
  默认 `false`
- **`reply.blacklistWords`** — 禁答词
  命中这些词的帖子不自动回复，转人工
  默认 `["客服","申诉","退款","充值失败","封号","举报","官方补偿","版号"]`

### 执行调度 · `exec`

并发、限速、队列、线程池

- **`exec.concurrency`** — 总并发度
  单队列模式下的并发上限。多队列模式下各队列独立配置
  默认 `1`
- **`exec.maxQueues`** — 最大队列数
  队列数不设硬上限（3 不是终点）：perPlugin 模式下每个插件一条，perPost 模式下每帖一条
  默认 `32`
- **`exec.rateLimit.mode`** — 限速模式
  off = 不限速；fixed = 用 perSecond（旧行为）；adaptive = 默认全速，检出 WAF 才退避（推荐）
  默认 `"adaptive"`，取值 off / fixed / adaptive
- **`exec.rateLimit.perSecond`** — 每秒任务数
  仅 mode=fixed 时生效。0 = 不限。旧的 0.17（≈1000/6000）实际把吞吐压到 6 秒/条
  默认 `0`
- **`exec.rateLimit.waf.cooldownMs`** — WAF 冷却(ms)
  adaptive 模式下检出 WAF 后的降速冷却时间
  默认 `60000`
- **`exec.rateLimit.waf.recoverEvery`** — 恢复试探间隔
  每成功 N 次尝试提速一次
  默认 `20`
- **`exec.rateLimit.waf.recoverFactor`** — 提速倍数
  默认 `1.5`
- **`exec.rateLimit.waf.hardBrakeAfter`** — 硬刹车阈值
  连续 N 次 WAF → 暂停所有发送
  默认 `3`
- **`exec.rateLimit.waf.pauseMinutes`** — 硬刹车时长(分钟)
  默认 `15`
- **`exec.workerPool.enabled`** — 启用线程池
  worker_threads 真并行（实测 3 线程 2.97x）。硬约束：worker 只发送，记账归父进程
  默认 `false`
- **`exec.workerPool.size`** — 线程数
  默认 `4`
- **`exec.workerPool.taskTimeoutMs`** — 单任务超时(ms)
  超时 → terminate 该线程并补一个
  默认 `120000`
- **`exec.queues.mode`** — 队列划分方式
  fixed = answer/social/summon 三条（旧行为）；perPlugin = 每个插件一条（互不阻塞）；perPost = 每帖一条（上限 maxQueues）
  默认 `"fixed"`，取值 fixed / perPlugin / perPost

### 官方 CLI 通道 · `taptapCli`

帖子全文与全部子回复只能靠官方 CLI 拿（旧接口 summary 硬截 200 字、child_posts 只返 2 条）

- **`taptapCli.enabled`** — 启用
  关闭则退回旧接口（会丢失全文与全子回复）
  默认 `true`
- **`taptapCli.binary`** — 可执行名
  npm i -g @taptap/cli 安装后的命令名
  默认 `"taptap-cli"`
- **`taptapCli.developerId`** — developer_id
  官方 CLI 要求必填整数；实测读接口不校验归属。等真实 dev_id 下来再换
  默认 `1`
- **`taptapCli.writeEnabled`** — 用 CLI 发送
  写接口需要「论坛主管理员」权限（普通版主 403，换 token 无效）。权限到位后再打开；现在写走页面内 fetch
  默认 `false`
- **`taptapCli.fallbackToOpencli`** — 失败回退旧接口
  true = CLI 挂了自动回退，绝不因为 CLI 不可用就不回复玩家。**建议永远保持 true**
  默认 `true`
- **`taptapCli.timeoutMs`** — 单次超时(ms)
  默认 `30000`

### 采集 · `collect`

怎么拉帖子与评论

- **`collect.sort`** — 排序
  默认 `"created"`，取值 created / commented
- **`collect.type`** — 列表类型
  默认 `"feed"`
- **`collect.commentDelayMs`** — 评论请求间隔(ms)
  默认 `1500`
- **`collect.commentPageSize`** — 评论每页条数
  旧接口的页大小。以前写死 30
  默认 `30`
- **`collect.commentMaxPages`** — 评论最大页数
  防失控上限
  默认 `8`
- **`collect.childPageSize`** — 子回复每页条数
  官方 CLI 的 child-replies 页大小
  默认 `50`

### 匹配阈值 · `match`


- **`match.autoReplyScore`** — 自动回复阈值
  相似度达到这个分才自动回
  默认 `0.65`
- **`match.suggestScore`** — 建议阈值
  低于自动阈值但高于这个 → 出草稿给人工
  默认 `0.45`
- **`match.maxAutoReplyPerRun`** — 单轮自动回复上限
  只对「手动 collect」生效；守望队列模式每轮只处理 1 条
  默认 `8`
- **`match.minPostAgeMinutes`** — 最小帖子年龄(分钟)
  太新的帖子先不抢答，给其他玩家机会
  默认 `10`

### 图片识别 · `image`


- **`image.enabled`** — 启用
  默认 `true`
- **`image.skipIntents`** — 跳过意图
  求码/好友码帖不识别图片
  默认 `["friendCode","tiangongCode"]`
- **`image.bareCodeIsIntent`** — 裸码也算求码
  默认 `true`
- **`image.ocr.enabled`** — OCR 启用
  需要 python scripts/ocr_server.py（端口 8790）
  默认 `true`
- **`image.vision.enabled`** — VLM 启用
  默认 `true`
- **`image.features.enabled`** — 模板匹配启用
  默认 `true`

### 夸奖通道 · `praise`


- **`praise.enabled`** — 启用
  提问帖里已有好答案 → 在那条评论下盖楼夸一句
  默认 `true`
- **`praise.signature`** — 带签名
  默认 `true`
- **`praise.minScore`** — 最低有效分
  默认 `1`
- **`praise.maxPerRun`** — 单轮上限
  默认 `3`

### 分享互动 · `share`


- **`share.enabled`** — 启用
  分享/记录/进度帖 → 去说一句鼓励，不答疑不评价数值
  默认 `true`
- **`share.signature`** — 带签名
  默认 `true`
- **`share.maxPerRun`** — 单轮上限
  默认 `2`

### 情绪陪伴 · `comfort`


- **`comfort.enabled`** — 启用
  纯情绪帖（绝了/可惜/憋屈）→ 陪一句共情，一帖一次
  默认 `true`
- **`comfort.signature`** — 带签名
  默认 `true`
- **`comfort.maxPerRun`** — 单轮上限
  默认 `2`

### 互动续聊 · `interact`


- **`interact.enabled`** — 启用
  玩家回应了我们 → 接一句
  默认 `true`
- **`interact.maxPerPost`** — 单帖上限
  默认 `1`
- **`interact.maxPerRun`** — 单轮上限
  默认 `3`
- **`interact.samePlayerLimit`** — 同玩家免降级次数
  默认 `1`
- **`interact.probabilityAfterLimit`** — 超限后回复概率
  默认 `0.5`
- **`interact.strongTextLen`** — 长文本必回阈值
  正文长度达到这个值 → 不受概率限制，必回
  默认 `40`
- **`interact.revisitRepliedPosts`** — 回访复查
  T30：**定期重读我们回过的帖**，看玩家有没有新回复。只靠通知会漏（@ 当时是纯文本不触发通知）→ 玩家回了我们却不知道（帖 872166231715613408 实例）
  默认 `true`
- **`interact.revisitDays`** — 回访窗口(天)
  只回访最近 N 天内我们回过的帖
  默认 `3`
- **`interact.revisitEveryMinutes`** — 回访间隔(分钟)
  同一帖最少隔多久回访一次（用 post_event 的 revisit 事件记账）
  默认 `30`
- **`interact.revisitLimit`** — 单轮回访上限
  每轮最多回访几个帖（按我们最后回复时间倒序）
  默认 `10`

### 喊话通道 · `summon`


- **`summon.enabled`** — 启用
  玩家 @ 我们/喊别名 → 应一声
  默认 `true`
- **`summon.aliases`** — 其它别名
  默认 `["大肥鱼","胖鱼","吃白米饭的"]`
- **`summon.matchRoles`** — 匹配版主语气
  默认 `true`
- **`summon.signature`** — 带签名
  默认 `true`
- **`summon.answerFromQa`** — 允许用答疑库作答
  默认 `true`
- **`summon.qaScore`** — 喊话场景匹配阈值
  默认 `0.6`
- **`summon.maxPerRun`** — 单轮上限
  默认 `3`
- **`summon.maxPerPost`** — 单帖上限
  默认 `1`

### 天宫码撮合 · `codeMatch`


- **`codeMatch.enabled`** — 启用
  有人贴码 → 把帖链接发给求码的人（只转达，不担保码有效）。⚠️ 键名是 codeMatch（大写 M），与 config.json 一致，勿改成小写
  默认 `false`
- **`codeMatch.shareWindowMinutes`** — 发码窗口(分钟)
  默认 `5`
- **`codeMatch.askWindowMinutes`** — 求码窗口(分钟)
  默认 `120`
- **`codeMatch.maxAskersPerShare`** — 每帖最多通知几人
  默认 `3`
- **`codeMatch.maxSharesPerAsker`** — 每个求码者最多被通知几次
  默认 `1`
- **`codeMatch.templates.enabled`** — 启用文案模板池
  默认 `true`
- **`codeMatch.templates.minTemplates`** — 低于此数量就补
  默认 `4`
- **`codeMatch.templates.targetTemplates`** — 补到多少条
  默认 `8`
- **`codeMatch.templates.maxAgeHours`** — 模板最长寿命(小时)
  默认 `24`

### 评论分析 · `comment`


- **`comment.enabled`** — 启用
  用规则识别「反对/纠错」与「补充」→ 写 data/comment-analysis.jsonl。**只分析不发送**
  默认 `true`

### 周报 · `weekly`


- **`weekly.enabled`** — 启用
  每周生成运营周报，数据全部来自本地 trace/usage，不调外部接口
  默认 `true`
- **`weekly.everyDays`** — 间隔天数
  默认 `7`
- **`weekly.days`** — 统计窗口天数
  默认 `7`

### 增量摄入 · `ingest`


- **`ingest.enabled`** — 启用
  默认关闭（避免自动摄入噪声）。填了官方 url 或开启 weekly 源后才建议打开
  默认 `false`
- **`ingest.sources.official.enabled`** — 官方公告源
  默认 `false`
- **`ingest.sources.official.urls`** — 官方公告 URL 列表
  默认 `[]`
- **`ingest.sources.weekly.enabled`** — 周报 md 源
  默认 `false`

### 评价分析 · `review`


- **`review.enabled`** — 启用
  **只读分析，绝不自动回复评价**（评价处置归人工）
  默认 `false`
- **`review.autoAnalyze`** — 自动分析
  默认 `false`
- **`review.lowScoreMax`** — 低分阈值
  默认 `2`

### 管理任务 · `modTasks`


- **`modTasks.enabled`** — 启用
  常驻 mod-watch：好友码帖识别与回复。**删除动作永不自动执行**
  默认 `true`
- **`modTasks.intervalSeconds`** — 轮询间隔(秒)
  默认 `120`
- **`modTasks.session`** — opencli 会话名
  默认 `"tapmod"`

### 归档 · `archive`


- **`archive.enabled`** — 启用
  每天整理一次：答疑库冷数据 + 帖子冷热分离
  默认 `true`
- **`archive.staleDays`** — 冷数据天数
  默认 `30`
- **`archive.keepStatePosts`** — state 保留帖子数
  默认 `300`
- **`archive.olderThanDays`** — 帖子冷归档天数
  默认 `30`

### 答疑库体检 · `qaHealth`


- **`qaHealth.enabled`** — 启用
  默认 `true`
- **`qaHealth.everyHours`** — 间隔小时
  默认 `24`
- **`qaHealth.autoPurge`** — 自动剔除
  正文里带我们签名（不该出现在库里）→ 移到归档。只移动不删除
  默认 `true`

### 答疑库自治治理 · `qaGovern`


- **`qaGovern.enabled`** — 启用
  默认 `true`
- **`qaGovern.auto`** — 自动执行
  true = 直接改库并可回滚；false = 只出报告
  默认 `true`
- **`qaGovern.dedupThreshold`** — 去重阈值
  包含度达到这个值判为重复
  默认 `0.94`
- **`qaGovern.neverCitedDays`** — 零引用归档天数
  默认 `45`

### 检索 · `retrieve`


- **`retrieve.topK`** — 召回条数
  默认 `8`
- **`retrieve.minScore`** — 最低分
  默认 `0.2`
- **`retrieve.rerank`** — 启用重排
  默认 `true`
- **`retrieve.denseBackend`** — 向量后端
  bge = Ollama bge-m3（更准，需 ollama serve）；char = 字符 n-gram（零依赖兜底）
  默认 `"bge"`，取值 bge / char
- **`retrieve.embedModel`** — embedding 模型
  默认 `"bge-m3"`
- **`retrieve.embedEndpoint`** — embedding 服务地址
  默认 `"http://127.0.0.1:11434"`
- **`retrieve.maxMaterialChars`** — 资料块预算(字符)
  默认 `1000`

### 重排模型 · `rerank`


- **`rerank.backend`** — 后端
  默认 `"onnx"`，取值 onnx / llm / off
- **`rerank.server`** — 服务地址
  由 scripts/ocr_server.py 提供 /rerank
  默认 `"http://127.0.0.1:8790"`
- **`rerank.modelDir`** — 模型目录
  需手动放置，agent 不会自动下载
  默认 `"E:\\Ollama\\models\\bge-reranker-v2-m3"`
- **`rerank.timeoutMs`** — 超时(ms)
  默认 `20000`

### 大模型 · `llm`


- **`llm.enabled`** — 启用
  默认 `true`
- **`llm.reuseDsh`** — 复用 DSH 模型配置
  true = 跟随 GUI 里选的模型，不用自己填 key
  默认 `true`
- **`llm.apiKey`** — API Key
  reuseDsh=false 时才需要
  默认 `""`
- **`llm.baseURL`** — Base URL
  默认 `""`
- **`llm.model`** — 模型名
  默认 `""`
- **`llm.dailyCallCap`** — 每日调用上限
  0 = 不限。超闸后快速失败转人工，不硬编
  默认 `300`
- **`llm.usagePersist`** — 调用计数落盘
  默认 `true`
- **`llm.temperature`** — 温度
  默认 `0.85`
- **`llm.maxTokens`** — 最大输出 token
  默认 `600`

### 结构化追踪 · `trace`


- **`trace.enabled`** — 启用
  每帖 verdict/gen/sent 事件写 reports/trace-<date>.jsonl
  默认 `true`
- **`trace.keepDays`** — 保留天数
  默认 `14`

### 周度评测 · `evalWeekly`


- **`evalWeekly.enabled`** — 启用
  每周一次**规则模式**评测（零 LLM 成本）
  默认 `true`
- **`evalWeekly.everyDays`** — 间隔天数
  默认 `7`

### 弃答回收 · `evalCandidates`


- **`evalCandidates.enabled`** — 启用
  C7 弃答的帖记 data/eval-candidates.jsonl，供后续补知识
  默认 `true`

### 渠道健康 · `llmHealth`


- **`llmHealth.enabled`** — 启用
  默认 `true`
- **`llmHealth.baseCooldownMs`** — 基础冷却(ms)
  默认 `120000`
- **`llmHealth.maxCooldownMs`** — 最大冷却(ms)
  默认 `1800000`
- **`llmHealth.smallTaskPreferOpenai`** — 小任务优先 openai 风格渠道
  默认 `true`

### 场景负反馈 · `sceneFeedback`


- **`sceneFeedback.enabled`** — 启用
  玩家反感某类行为时，跨帖收敛这一类
  默认 `true`
- **`sceneFeedback.cooldownMinutes`** — 冷却分钟
  默认 `60`
- **`sceneFeedback.downgradedProb`** — 降权后概率
  默认 `0.25`
- **`sceneFeedback.halfLifeHours`** — 半衰期(小时)
  默认 `24`
- **`sceneFeedback.skipMinutes`** — 跳过分钟
  默认 `60`

### 刷屏自审 · `spamStop`


- **`spamStop.enabled`** — 启用
  自查我们在这帖回了几条、几条同样含义 → 认错 + 停掉凑热闹类
  默认 `true`
- **`spamStop.dupSim`** — 同样含义阈值
  默认 `0.3`
- **`spamStop.minDup`** — 最少重复条数
  默认 `2`
- **`spamStop.proactiveMax`** — 预防性上限
  默认 `3`
- **`spamStop.globalMinutes`** — 全局冷静分钟
  默认 `30`

### 验证 · `verify`


- **`verify.cacheTtlHours`** — 判定缓存 TTL(小时)
  默认 `24`
- **`verify.postCheck`** — 生成后忠实度自检
  默认 `true`

### 联网补答 · `websearch`


- **`websearch.enabled`** — 启用
  答疑库没命中时联网搜一次，按 50% 置信度作答。依赖 baidu-websearch skill
  默认 `true`
- **`websearch.timeoutMs`** — 超时(ms)
  默认 `60000`

### 守护循环 · `watch`


- **`watch.intervalSeconds`** — 轮询间隔(秒)
  默认 `120`
- **`watch.minOpGapMs`** — 操作最小间隔(ms)
  默认 `300`
- **`watch.wafCooldownMinutes`** — WAF 冷却分钟
  默认 `15`

### 文件路径（内部） · `paths`

⚠️ 内部字段，一般不用改。`{{SKILL}}` 会展开成 skill 根目录，所以 skill 换位置也不用改这里

- **`paths.dataDir`** — 数据目录
  默认 `"{{SKILL}}/data"`
- **`paths.qaFile`** — 答疑库文件
  默认 `"{{SKILL}}/qa/答疑库.md"`
- **`paths.usageFile`** — 引用统计
  默认 `"{{SKILL}}/data/qa-usage.json"`
- **`paths.archiveDir`** — 归档目录
  默认 `"{{SKILL}}/qa/归档"`
- **`paths.stateFile`** — 守护状态
  默认 `"{{SKILL}}/data/state.json"`
- **`paths.modStateFile`** — 管理任务状态
  默认 `"{{SKILL}}/data/mod-state.json"`
- **`paths.reportsDir`** — 报告目录
  默认 `"{{SKILL}}/reports"`
- **`paths.qaIndexFile`** — 答疑库索引
  默认 `"{{SKILL}}/data/qa-index.sqlite"`
- **`paths.postDbFile`** — 帖子记录库
  默认 `"{{SKILL}}/data/post-records.sqlite"`

### 答疑库检索 · `qa`

答疑库相似度检索的向量设置

- **`qa.vector.backend`** — 向量后端
  char = 字符 n-gram TF-IDF（零依赖）；http = 接本地 embeddings 服务，失败自动退回 char
  默认 `"char"`，取值 char / http
- **`qa.vector.endpoint`** — 向量服务地址
  默认 `""`
- **`qa.vector.model`** — 向量模型名
  默认 `""`

---

生成时间：2026-11-23 02:30:19
