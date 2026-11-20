# 变更记录（Changelog）

> 本文件记录 `taptap-pvz2-forum-moderator` 的版本沿革与关键改造。
> 操作细节见 `SKILL.md`；本文件侧重「改了什么、为什么、踩了什么坑」。

---

## v2.0.0 — 官方 CLI 读通道 + 配置统一 + 性能重做（2026-11-20）

### 背景
三个问题同时逼到台面：① 回复「@ 两次」；② 长帖答偏（正文读不全）；③ 回复慢（6 秒/条限速）。排查后发现根因都不是表面现象——**是平台接口硬截断、配置三重语义、以及每步都 spawn 浏览器**。

### 一、官方 CLI 读通道（解决「读不全」）
旧接口两个**平台级硬截断**：
- `moment/v3/detail` 的 `topic.summary` **恒定 200 字**（5 种参数组合都一样，无全文字段）→ 长帖答偏，我们曾自己回复「正文断在这儿了？」
- `child_posts` 只返**前 2 条**，且 `by-comment` 400 / `child`、`by-parent` 404 → 自己发的子回复读不到（幂等门盲判）、漏读关键答案

改用 `taptap-cli community-management`（`@taptap/cli`）：
- `get-community-moment` → `content` **954 字全文**（同帖 summary 仍 200）
- `list-community-moment-child-replies` → **total=5 全量**

新增 `lib/taptap-cli.mjs`（读 5 个接口 + `listThread` 聚合 + `available`）、`lib/thread-source.mjs`（CLI 优先 + 旧接口**自动降级** + 结构适配）。
**权限边界**：读只要「该论坛版主」；写要「论坛主管理员」（普通版主 403，换 token 无效）→ `taptapCli.writeEnabled` 默认 false，写继续走页面内 fetch。

### 二、@ 双重修复
线上实测 4/4 条 interact 回复全是 `@狐玖儿 @狐玖儿`——提示词让模型写 @，发送层又拼一次。
三道保险：提示词禁止写 @ → `stripLeadingMention()` 剥开头所有 @ → `assertSingleMention()` 发送前断言同名只出现一次。

### 三、配置统一（`scripts/config/schema.json`）
以前一个功能有 **3 套开关**（`features.*` / `plugins.*` / 顶层 `x.enabled`），且 `plugins` 覆盖 `features`，读配置必然误判。
- `schema.json` 为唯一权威（169 项字段：类型/默认/范围/enum/说明）
- `lib/config.mjs`：迁移（双写保留旧键）+ 补默认（只补缺失）+ 环境变量覆盖 + 校验（不阻断运行）
- `docs/config-reference.md` **自动生成**（`node scripts/config-doc.mjs`，`--check` 可校验过期）
- 9 处硬编码变可配：`reply.apiIntervalMs` / `reply.maxChars.post|nested` / `collect.commentPageSize|commentMaxPages|childPageSize` / `exec.maxQueues` / `interact.strongTextLen` / `taptapCli.*`

### 四、性能重做（实测数据驱动）
| 项 | 改前 | 改后 |
|---|---|---|
| 限速 | 4 处叠加 ≈ 6 秒/条 | `mode=adaptive`：默认全速，检出 WAF 才 ×0.5 退避 + 硬刹车 |
| 队列 | 硬编码 3 条（social 合并 4 通道） | `perPlugin` 每插件一条 + `maxQueues=32` |
| `send` | 5578 ms | **~1700 ms** |
| `fetch_comments` | 1880 ms | ~1600 ms（多回复帖 **3.1x**） |
| 单帖合计 | ~9.8 秒 | **~5.6 秒（-43%）** |

新增 `lib/perf.mjs`（分阶段打点）+ `scripts/report-perf.mjs`（p50/p90/瓶颈标注）+ `lib/rate-adapt.mjs`（AIMD 自适应限速）。

### 五、修掉的三个隐藏 bug
1. **`ingest` 不检查 `llm.enabled`**：LLM 关闭时仍逐条撞渠道 → 留下未收尾请求，进程退出触发 libuv 断言 `UV_HANDLE_CLOSING`，**测试 100% 崩**。
2. **`ensureOrigin` 每次都跑 `browser state`**（实测 3327ms）：每条回复白跑一次。加 60 秒缓存后 → **1 ms**。
3. **`engines.node` 写 `>=18`**：但代码用了 `node:sqlite`（需 **≥22.5**），照文档装会在**运行时**才崩，极易误判。

### 六、文档
新增 `docs/install.md`（TL;DR + 6 步 + 首次检查清单）、`docs/install-requirements.md`（依赖矩阵 + 版本兼容表）、`docs/install-services.md`（Python 服务 + 模型放置 + fp16 坑）、`docs/install-troubleshooting.md`（**8 大类实际踩过的坑**）、`docs/config-reference.md`（自动生成）。

### 测试
新增 8 个测试套件（`test-mention-dedup` / `test-taptap-cli` / `test-thread-source` / `test-config` / `test-perf` / `test-rate-adapt` / `test-multi-queue` 等），全套 **80 套件 0 失败**。

---

## v1.4.0 — 图片识别流水线（S1–S6，带门控）

### 背景
论坛大量帖子带图（求助截图 / 活动页面 / 植物图鉴 / 晒卡），此前 skill **零图片识别**：`flattenContents` 只抽文本丢图，好友码截图被标「码在图里取不到」。大哥 2026-11-16 拍板**带门控流水线**设计（调研 + 设计稿见任务目录 `output/PVZ2论坛图片识别调研报告-20261116.md` / `output/PVZ2图片识别-技术设计稿-20261116.md`）。

### 三条规则
1. **好友码/天宫码意图 → 跳过图片识别**（走原固定提醒/撮合流程，不读图）。
2. **其他帖先判图片相关性**（纯启发式起步）：无关配图跳过、相关图才识别。
3. **识别内容并入 `post.text`** → QA 匹配 / 联网搜索 / LLM 组答自动受益（现有通道，无需新建）。

### 新增模块
- `lib/image.mjs`：流水线编排（`isCodeIntent` / `imageRelevance` / `enrichPostImages` / `defaultRecognize`）。
- `lib/ocr.mjs` + `scripts/ocr_server.py`：**S3 RapidOCR 本地 OCR** 微服务（`/ocr` + `/match`，`pip install rapidocr`）。
- `lib/vision.mjs` + `llm.mjs` 多模态扩展：**S4 VLM 看图**（`resolveVisionChannels` / `chatVision` / `toApiContent`，**跟随 DSH + 他人 key**）。
- `lib/features.mjs` + `assets/game-features/`：**S6 模板匹配**（`features.json` + 模板图，opencv 多尺度 `/match`）。
- `lib/image-cache.mjs`：识别结果缓存（`data/image-cache.json`，TTL）。
- `http.mjs` `extractImages`：取图（实测图在 `moment.topic.footer_images[]`，feed 层即带，匿名+X-UA，CDN 无防盗链）。
- `collect.mjs` 接入 `enrichPostImages` + 缓存；`compose-reply.mjs` 图片二手信息置信度框定。

### 配置
`config.image`（enabled / skipIntents / relevanceGate / ocr / vision / features）+ `config.llm.vision`（他人 key / 跟随 DSH）。详见 `references/image-recognition.md`。

### 测试
新增 5 套（test-image-gate / test-ocr-bridge / test-vision-channel / test-image-pipeline / test-features），**共 33 套全绿**。OCR 与模板匹配经真实活动页面样本端到端验证（识别「获得奖励/狂欢嘉年华/钻石334」；钻石模板自匹配命中）。

### 踩坑
- 图片**不在 contents.json 而在 `topic.footer_images[]`**；匿名需 **X-UA 头**（否则 `INVALID_XUA`，非 WAF）；moment id 用 **`id_str`**。
- `features.mjs` 在 `scripts/lib/`，`SKILL_ROOT` 要 `resolve('../..')` 才到 skill 根（少跳一级读不到资产库）。
- `llm.mjs` `return /regex/i.test()` 触发 collect-scope 误报（`i` 标志被当变量）→ 正则提成模块常量 `VISION_RE`。
- RapidOCR 3.x 返回 `RapidOCROutput.txts/.scores`。

---

## v1.3.4 — doctorOk 兼容新格式 + taptap-cli / 自动化任务结论更正

### A. 修复：doctorOk 误判 opencli 不可用（DSH 升级引发，**严重**）
- **事故**：DSH 升到 0.2.2-rc.2（opencli 2.0.3）后，`opencli doctor` 输出从**纯文本**改成 **JSON**
  （`{"ok":true,"data":{"extensionConnected":true,...,"issues":[]}}`）。
  `doctorOk` 只认旧正则 `/Extension:\s*connected/` → 永远判「不可用」→
  **所有浏览器通道操作被静默跳过**（回复/夸码/撮合/版主任务全废，日志只有一行 `[FAIL] opencli 不可用`）。
  mod-watch 甚至因此直接退出码 1。
- **修法**：`lib/replier.mjs` 的 `doctorOk` 两种格式都认 —— 优先解析 JSON（`extensionConnected` 或
  `profiles[].extensionConnected` 为 true 且 `issues` 为空），解析不了再退回旧文本正则。
  `scripts/schedule.ps1` 的 doctor 自检同样兼容两种格式。
- **新增 `test-doctor-ok.mjs`（9 项）**：新 JSON / 旧文本 / 真不通 / profiles 兜底 / 坏输出不崩，全锁住。
- ⚠️ 教训：**上游 CLI 的输出格式是会变的**，凡是「解析外部命令输出」的判定都要兼容 + 有回归测试，
  否则一次升级就静默废掉整条通道。

### B. 文档更正：taptap-cli 写能力已出现，但当前账号无开发者 scope（2026-11-13 实测）
- `references/api.md` §7 旧写「community-management 共 8 个方法，全部只读」→ **已过时**。
  实测 taptap-cli 0.2.2-rc.2 有 **16 个命令**，含 `create-community-moment-reply`（回帖）、
  `create-community-moment-reply-child`（楼中楼）、发帖草稿三件套、上传图片/视频。
- **新能力**：`contents` 行内支持 **tap_emoji**（`info.id`）→ 表情本可直接经 API 发，不必驱动浏览器点表情面板。
  （行内**不支持 link** → 撮合链接只能当纯文字 URL，是否渲染成可点链接待实测。）
- **但当前账号调不动**：`developers.count=0`，所有命令要 `--dev-id/--app-id`，实调报
  `no TapTap developer accounts are visible to the current credentials` → 连只读列表都调不动。
- `SKILL.md` 硬约束①「官方无写接口」更正为：**结论（回复靠 opencli）不变，但理由是「账号无开发者 scope」，不是「官方无写接口」**。
  拿到开发者账号后 API 直发是更稳方向（可选增强，不替换现有 opencli 通道）。

### C. 文档新增：DSH「自动化任务」不能托管守护（概念错配）
- DSH Schedule 的性质是「到点把指令投递到 Agent 会话由 LLM 执行」，**不直接拉起 OS 进程**。
  拿它启动守护会踩：session 级进程随宿主死、端口锁致第二次起不来、每次烧 LLM 额度。
- **正确分工**：守护存活 → Windows 计划任务（`schedule.ps1`，唯一能跨 DSH 重启/升级活着）；
  巡检 / 日报 → DSH 自动化任务（可选）。
- **当前决策（用户 2026-11-13）**：Windows 计划任务不装、DSH 自动化任务也先不建；守护继续用会话后台进程跑。

### D. 新增：游戏评价（review）接口能力入库（2026-11-13）

大哥提供两条**真实 cURL**（评价列表 / 评价回复），要求「学习验证，保存的 skill 中」。
逐条实测校准后入库（**全程只读**，没额外发过任何回复）。

**新增能力**（`scripts/lib/review.mjs` + `taptap-api.mjs` 四个方法）：

| 方法 | 端点 | 说明 |
|---|---|---|
| `api.reviewList({appId, limit, sort})` | `GET /webapiv2/review/v2/list-by-app` | 评价列表（**匿名可读**） |
| `api.reviewReply({reviewId, text, signature})` | `POST /webapiv2/review-comment/v1/create` | 回一条评价 |
| `api.reviewComments({reviewId, limit, from, order})` | `GET /webapiv2/review-comment/v1/by-review` | 读**全量**回复 |
| `api.hasReviewReplyText({reviewId, text})` | （基于上一条） | 校验回复是否落库 |

**实测踩到的坑（都写进 `references/review-api.md`）**：

1. ⚠️ **评价回复的 `contents` 是纯文本**，不是论坛那套富文本 JSON（`[{type:'paragraph',…}]`）。
   落库形态 = `{text, raw_text}`。→ 表情标记一律**剥掉**再发（表情节点在评价接口没验证过）。
2. ⚠️ `by-review` 的 **`order` 必填**（`asc|desc`，oneof 校验），漏了 400。
3. ⚠️ `by-review` 的 **`limit` 上限是 10**（15 / 20 都 400：`failed on the 'max' tag`）。
4. ⚠️ **列表里的 `review_comments` 只是预览子集**（实测：列表 1 条 vs by-review 2 条）
   → 校验落库必须走 `by-review`，否则会误判「没发出去」。
5. ⚠️ `review/v2/detail` 的 `data.review` 是**空壳**，真数据在 `data.moment.review`。
6. 列表接口**不需要 Cookie**（匿名可读），但仍走页面上下文统一通道。

**无损验证方式**：没真发新回复，而是**读回大哥手动发过的那条**（review `51123606` →
comment `36692150`，作者 `63****64`）确认端点与参数正确。

**顺带的结构改动**：`stripEmojiMarks` 从 `taptap-api.mjs` 挪到新模块 `lib/text.mjs`
（`taptap-api.mjs` 再导出一次，老引用不用改）—— 否则 `taptap-api.mjs` ↔ `review.mjs`
会形成**循环依赖**。新增单测 `test-review-api.mjs`（74 条断言），测试套数 26 → **27**。

> 当前只入库**能力**（A 级），**尚未**接入自动值守（C 级方案见 `docs/方案-评价自动值守.md`）。

### E. 清理失效内容 + 钉死「守护每轮只处理一条」语义（2026-11-13，用户强烈纠正后）

**起因（我犯的错）**：给 TapTap 官方的确认文档里写了「配置上限：单轮答疑 8 条」——
这是**替官方虚构了一个我们没做过的承诺**。真实情况：**答疑守护是队列模式，每轮只处理队首一条，
没有「每轮 N 条」这概念**；`match.maxAutoReplyPerRun`(8) **只管手动单次跑 `collect.mjs`**，守护根本不读它。

**「8 条」残留的根源**：`config.collect.topN` 早已随队列模式移除，但 `collect.mjs` / `watch.mjs` /
`fetch-latest.mjs` 三处仍在 `config.collect.topN ?? 8` 回落 → 读一个不存在的 key，看着像「一轮 8 条」。

**代码清理**：三处删掉 `config.collect.topN` 引用；`TOP` 统一为 `Math.max(Number(top ?? 10), 10)`
并注明「**这是拉取窗口，不是回复条数**」；`collect` 日志区分队列模式（单帖处理）vs 手动模式（窗口 + 单轮上限）。

**文档清理（失效内容移除，历史留副本）**：
- `docs/方案.md` **重写为《架构总览（当前版本）》**；初版正文归档到 `docs/历史/方案-初版-20261026.md`
- `docs/evidence/01-facts.md` 加「历史流水非当前规格」警示头 + 4 条已推翻结论更正表
- `references/ops.md` 风险控制节明写「守护没有每轮 N 条」「maxAutoReplyPerRun 只管手动跑」「collect.topN 已移除别加回」
- `references/mod-task.md` / `SKILL.md` 澄清 `maxPerRound` 是 **mod-watch** 的参数（实际值 0=处理到队列空，旧文档「默认 20」已过时）

**新增护栏 `test-watch-semantics.mjs`（16 条断言）**：剥注释后检查三文件不含 `collect.topN`、
config 无该键、watch 只取 `queue[0]`+`only:[head.id]`、watch 不读 `maxAutoReplyPerRun`、
TOP 用 `??10`、ops.md 口径一致。**谁再把失效配置加回来 / 把守护改成批量，当场红。**
测试套数 27 → **28**（`package.json` test 脚本同步补齐 review-api + watch-semantics）。

> ⚠️ 教训：**给外部看的文档必须以代码实际行为为准**，不能照抄配置项字面意思；
> 配置删/改后必须同步清理 references/docs/SKILL 里对它的所有描述。

---

## v1.3.3 — 天宫码撮合扩容：模板池动态化 + 求码窗口 2 小时

用户 2026-11-12 要求两条：
> 「现在这套「4 选 1 + 按帖 id 散列」要扩。每次预生成使用后替换。即 LLM 预生成模板，使用完即抛弃，
> 模板减少就替换已使用的模板。补足模板数。（建议：少于 4 模板，补足到 8 模板，每次 LLM 预生成模板）」
> 「撮合通知，时间范围扩大一下。改为 2 小时内求天宫码的贴。」

### A. 撮合文案模板池（新增 `lib/code-match-templates.mjs`）
- **用一条少一条**（用完即弃）→ 同一条模板不会被发两次（旧方案是「4 选 1 + 按帖 id 散列」，同帖可重复）。
- **LLM 预生成**：池里剩 < `minTemplates`(4) → 生成到 `targetTemplates`(8)。
- **兜底**：池空 / LLM 挂 / 首次运行 → 用**内置 4 条模板**（绝不因生成失败就发不出撮合通知）。
- **质量闸**（不合格直接丢）：承诺/引流词、含真实网址、长度异常、缺人格自称「小鲸鱼」、与已有重复。
- **占位符**：模板带 `{link}`，发送时替换成真实链接（位置由模板决定 —— LLM 多放在句中或句尾，比死放句尾更自然）。
- **池文件 `data/code-match-templates.json`**：**独立文件、watch 拥有** —— 不写 state.json（那边 collect 拥有，双写会互相覆盖）。
- **新增老化（建议项）**：模板带 `createdAt`，超 `maxAgeHours`(24) 作废。
  ⚠️ 为什么加：一天只撮合 1~2 次时，8 条只少 1~2 条，剩下 7 条永远不会被替换 → 实际退化回「固定池」，
  跟原来的 4 选 1 没本质区别。加老化后池子定期换新血，才真的「每次都是新的」。
- **池维护与 feed 解耦**：读取/补足放在撮合门外，**不管本轮有没有新帖都维护**。
  ⚠️ 为什么：最初把补足绑在 `pulledForMatch`（本轮新帖）上，论坛安静没新帖时池子永远补不满。
- **择优补到 target**：质量闸会筛掉一些（不同渠道合规率不同）→ 多要几条（`need+4`，封顶 12）、但只补到 `targetTemplates`、不超。
  实测：首轮 0 条 → 预生成 12 → 择优补入 8 → 池 8 条。

### B. 求码窗口 30 分钟 → 2 小时
- `config.codeMatch.askWindowMinutes` 30 → 120（发码帖窗口仍是 5 分钟不变）。
- **新增 `maxSharesPerAsker`（默认 1）**：同一个求码帖最多被通知 1 次。
  ⚠️ 为什么必须加：窗口从 30 分钟放大到 2 小时后，同一个求码帖很容易被**多个不同的发码帖**各通知一次
  → 同一个帖子被回复 2~3 次 = 又一种刷屏（用户 2026-11-12 专门处理过刷屏，不能自己又造一个）。

### C. 测试
- 新增 `test-code-match-templates.mjs`（32 项）：质量闸 / 解析（含围栏与夹带解释）/ 取用即弃 / 渲染 / 老化 / 预生成过滤（注入假 ask，不联网）。
- `test-watch-queue.mjs` 更新：2 小时窗口（100 分钟能撮合、121 分钟不能）、同一求码帖只通知 1 次、`maxSharesPerAsker=0` 不限。

---

## v1.3.2 — 行为治理：刷屏自查 + 场景级负反馈

本次会话核心。目标：**让小鲸鱼「认得出自己闯祸、收得住手」，并且玩家反感某类行为时跨帖收敛。**

### A. 刷屏自我审查 + 刹车（`lib/complaint.mjs`）
- **事故背景**：两个帖子连发 13 条几乎一样的「恭喜恭喜」式凑热闹回复，玩家开骂「这大肥鱼疯了」，版主只能手动道歉。
- **闭环三步**：① 审查自己（数这帖回了几条、几条「同样含义」）→ ② 认错（走回复流程、语气认错、自审结论喂给模型）→ ③ 刹车。
- **「同样含义」判定**：char-ngram 包含度（不同语句也算）。实测不同内容=0.000、同义凑热闹=0.15~0.67，分离干净。
- **刹车范围（关键）**：**只停「凑热闹类」**（夸无私分享/分享互动/情绪陪聊）；**答疑、认错致歉、有内容的互动续聊照常** —— 只停无意义刷屏，不是停止回复。
- **两条触发**：投诉触发（玩家指出 + 自审确认重复≥2）；预防性自查（不等投诉，这帖已回 >3 条自动收手）。
- 喊话通道与互动续聊通道**共用判定** → 玩家在楼中楼骂我们也认得出。

### B. 场景级负反馈（`lib/scene-feedback.mjs`，跨帖）
- **三个捧场场景独立计分**：`praise_code`（贴码捧场）/ `share_reply`（分享凑热闹）/ `comfort`（情绪陪聊）。
- **三档用区间判断**（`config.sceneFeedback.bands`）：
  - `normal (−∞,1.5)` 观察 / `downgraded [1.5,2.5)` 降权（每轮1条+25%）/ `cooldown [2.5,∞)` 冷却（60min+踢出队列）。
- **信号归属**：提到我们（签名/别名）→满权重；回复/@我们→满权重；其余→0.5。**第二人称「你/你们」不算对我们说**。
- **跨帖传染**：信号涉及整类（「捧场/一直/天天/到处…」）→同大类其它场景**减半**跟着降权；只喷一种→不传染。
- **正反馈**：玩家夸我们（「谢谢小鲸鱼」）→该场景 **−1**（只认夸我们的、不传染、可拉回观察档）。
- **密度信号（全站口径）**：30min 内同类帖≥3 → +2 分；分母用 `state.posts` 累积，按窗口去重。
- **衰减**：24h 半衰期 —— 昨天的烂场子今天不该继续罚。
- **队列收敛**：冷却→该场景帖全踢；降权→只留最新一条。踢出凭据写**独立文件** `data/watch-scene-skip.json`（不写 state.json，避免与 collect 互相覆盖），watch 每轮重读。
- **只影响捧场类**：答疑/认错/有内容互动/天宫码撮合不受影响。

### C. 人工解除（`scripts/scene-admin.mjs`）
```
node scripts/scene-admin.mjs list              # 看各场景分数/档位/冷却/被踢帖数
node scripts/scene-admin.mjs reset praise_code # 解除某场景（清分数+冷却+踢出凭据）
node scripts/scene-admin.mjs reset-all         # 解除全部
```
同时清三处，watch 每轮重读凭据 → **即时生效不用重启**。

### D. 本次修掉的坑（重要经验）
| 坑 | 后果 | 教训 |
|---|---|---|
| **浮点掉档** | 半衰期让分数 `1.9999…`，`>=` 判断永远差一点触发不到档位 | 比阈值前先四舍五入到 3 位 |
| **测试用精确相等比分数** | 半衰期让分数是 `0.4999999959887316` 而非 `0.5`；两次 `Date.now()` 跨一毫秒就挂 → **随机 flaky** | 断言分数一律用 `near()` 容差，别用 `===` |
| **密度时间单位** | `publishTime` 是秒、按毫秒比 → 密度信号一次都没触发 | 时间戳统一单位再比 |
| **密度分母偏窄** | 只数本轮≤8条，低估泛滥 | 用全站累积口径 |
| **密度每轮重复计分** | 泛滥期每轮+2 虚涨 | 按窗口分桶 cid 去重 |
| **签名未剥就比较相似度** | 每条都带签名→正常回复被误判重复 | 比相似度前先剥签名/别名 |
| **`emoji is not defined`** | 分享互动日志引用未定义变量→整轮处理中断 | 日志变量要在作用域内 |
| **`sceneGateOf is not defined`** | 场景闸定义在 3d 分享块里，3e 安慰块跨块引用→**每条都报异常，答疑/夸码/撮合全废** | 兄弟块共用的变量要提到函数体作用域；已加静态守卫（见 F） |
| **游戏语境误判** | 「刷副本/刷金币」是日常、「这操作魔了」是赞叹 | 反感词要带限定词 + 赞叹语境排除 |

### E. 阈值是暂定值
`bands / cooldownMinutes / downgradedProb / halfLifeHours / flood*` 全在 `config.sceneFeedback`，**改配置即可，不用动代码**。后续按实际效果调。

### F. 静态作用域守卫（`scripts/test-collect-scope.mjs`，新增）
- **为什么**：`collect.mjs` 2000+ 行、几十个 if 兄弟块，已因「变量定义在 A 块却被兄弟块 B 引用」翻车两次（`shares`、`sceneGateOf`）。单测只测 lib 函数，**覆盖不到作用域**——23 套全绿也照样漏到线上。
- **做法**：仓库零依赖，自带词法作用域分析器——抹掉注释/字符串/正则/模板串→按花括号建作用域树→每个标识符从内往外找绑定，找不到且本文件声明过→报「跨块引用」。
- **自检**：内置坏样本必须抓到、提升后的好样本必须干净，防止分析器自己坏成「永远报干净」。
- **覆盖**：扫描 `scripts/` 全部 `.mjs`（含 lib 与测试），当前 98 文件全干净。已并入 `npm test` 与发布白名单。

### G. 表情落位支持注入表情表（发布侧自测缺口）
- **缺口**：`loadEmojiMap()` 读运行时采集的 `data/emoji-map.json`，而 `data/` 不进仓库 → 发布副本里 `npm test` 的表情断言必挂（v1.3.1 就是这样，先天缺口）。
- **修法**：`applyEmojiPlacement` / `pickEmoji` 加**可选** `map` 参数 —— 不给时行为完全不变（仍读采集表），测试则自带固定表情表。
- **效果**：发布仓库也能自测通过，且测试不再依赖采集产物（采集表变了也不会误挂）。

---

## v1.3.1 — 口径统一：置信度 ≠ 概率
- **置信度/可信度** = 这条答案有多可信（答疑库五档、联网答案 50% 置信度）。
- **概率** = 这次要不要回（互动续聊回复概率）。两者不混用。
- 答疑库档位标签 `低/中/高概率` → `低/中/高置信度`（数据字段名「置信度」不动，老库照常解析）。

## v1.3.0 — 联网补答 + 多项行为能力
- **新技能 `baidu-websearch`**（独立可复用，纯查询+三级降级+单轮配额）：结果页抠 `sseApi`→SSE 流式拼答案（`mode=answer`）；无则退普通结果页（`mode=page`）；都没有返回失败原因。
- **联网补答接线**：答疑库没命中→搜一次；`answer`→升待回复、按 **50% 置信度**作答；`page`/失败→转人工。薄适配层 `lib/websearch.mjs`，找不到就按正常流程走。
- **天宫码撮合**、**喊话分流护栏**（调戏/问罪/注入）、**求码帖全网静默**、**动态窗口** `window-fetch`+高水位游标。
- **gaps 报表新增「搜索」列**（只有结果页/没搜到/被风控/搜到答案），作为优先补库线索。

## v1.2.0 及更早
置信度体系+交叉验证+三源队列+端口锁+页面通道+重复回复修复+安慰通道+签名/表情规则等（见 git 历史）。

---

## 发布约定
- 运行目录 `~/.dsh/skills/taptap-pvz2-forum-moderator/` 是**运行库**；仓库副本由 `publish-repo.mjs` 脱敏后生成。
- **答疑库同步方向只能是 运行中→构建源**，反向覆盖会丢自动沉淀。
- 发布前跑 `publish-repo.mjs`（个人信息扫描 + 覆盖度体检）；自检 28 套全绿再发。
