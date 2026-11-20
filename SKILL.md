---
name: taptap-pvz2-forum-moderator
description: 植物大战僵尸2 TapTap 论坛版主/答疑组自动化助手。按发布时间抓取 PVZ2 论坛最新帖子，用 skill 内置的答疑库（qa/答疑库.md）做关键词+相似度匹配，命中则通过 opencli 驱动已登录的 Chrome 打开帖子、点选 TapTap 表情并回复（带签名「版主助手-小鲸鱼」），同时把全部问题按「未回复待回复 / 已回复 / 无需回复 / 需人工处理」四类标记输出成 Markdown 与 CSV 报表，支持持续守护模式（2分钟重排队列）。适用于 TapTap 论坛版主日常答疑、补充答疑库后自动回复、问题清单统计与是否回复标注。
---
# 植物大战僵尸2 · TapTap 论坛版主答疑自动化
> 定位：把「每天收问题 → 命中答疑库就回 → 出全量清单 → 补答疑库后自动回」做成脚本。
> **自包含**：答疑库、状态库、报表都在本 skill 目录内，整目录拷给别人解压即用。
> 关键约束（实测，改代码前先读）：TapTap 官方 CLI 不支持回帖；匿名读接口有 **WAF 限流**；`limit` 上限 **10**；排序要 `sort=created`。
## 📚 文档导航（本文件只留纲要，细节在 references/）
| 想了解 | 看哪里 |
|---|---|
| **完整手册**（原 SKILL.md 全文，1830 行） | [references/skill-full.md](references/skill-full.md) |
| 检索链路（混合检索/重排/组装/验证） | [references/retrieval.md](references/retrieval.md) · [references/context-verify.md](references/context-verify.md) |
| 置信体系与负反馈 | [references/confidence.md](references/confidence.md) |
| 实体路由 + 评测 harness | [references/entity-eval.md](references/entity-eval.md) |
| 图片识别流水线 | [references/image-recognition.md](references/image-recognition.md) |
| 安装/依赖/模型 | [references/install-guide.md](references/install-guide.md) |
| 运维/排障/硬约束 | [references/ops.md](references/ops.md) |
| 版本沿革与踩坑 | [CHANGELOG.md](CHANGELOG.md) |
## 目录结构
```
taptap-pvz2-forum-moderator/
├── SKILL.md                  本文件（纲要）
├── references/               细节文档（skill-full.md = 原全文）
├── scripts/                  代码（零第三方依赖；ocr_server.py 需 pip install rapidocr）
├── assets/                   模板 + game-features/ + eval-set.json
├── qa/答疑库.md              ★ 答疑数据库（直接编辑）
├── data/                     运行时状态（state.json / SQLite / 缓存）
└── reports/                  运行时报表（含 trace / daily / eval）
```
## 快速开始

```bash
# 1) 确认环境（opencli 扩展要连上，Chrome 要已登录 TapTap）
opencli doctor

# 2) 拿自己的 user_id（用于判断「是否已回复」），填进 scripts/config.json
node scripts/whoami.mjs

# 3) 写答疑库：直接编辑 qa/答疑库.md（格式见 assets/qa-library.example.md）

# 4) 全部自检（改规则前后都要跑，28 套）
node scripts/test-api-contents.mjs && node scripts/test-archive.mjs && node scripts/test-code-match-templates.mjs && \
node scripts/test-cold-store.mjs && node scripts/test-collect-scope.mjs && node scripts/test-comfort.mjs && \
node scripts/test-complaint.mjs && node scripts/test-doctor-ok.mjs && node scripts/test-interact.mjs && \
node scripts/test-limits-codes.mjs && node scripts/test-match.mjs && node scripts/test-mod-task.mjs && \
node scripts/test-post-records.mjs && node scripts/test-praise.mjs && node scripts/test-publish-mask.mjs && \
node scripts/test-qa-health.mjs && node scripts/test-qa-vector.mjs && node scripts/test-question.mjs && \
node scripts/test-removed-list.mjs && node scripts/test-review-api.mjs && node scripts/test-scene-feedback.mjs && \
node scripts/test-summarize.mjs && node scripts/test-summon.mjs && node scripts/test-thread-context.mjs && \
node scripts/test-variants.mjs && node scripts/test-watch-semantics.mjs && node scripts/test-watch-queue.mjs && node scripts/test-websearch.mjs

# 5) 跑一轮（判定 + 预览回复，不发送）
node scripts/watch.mjs --once --dry-run

# 6) 满意后常驻
node scripts/watch.mjs
```
## 四类标记

每条帖子只会落在其中之一，`reports/questions.md` 与 `.csv` 按这四类分区：

| 标记 | 值 | 触发条件 |
|---|---|---|
| ⏳ 未回复待回复 | `pending` | 答疑库分数 ≥ `autoReplyScore`(0.65)，且过了新帖冷却期 |
| ✅ 已回复 | `replied` | 发送成功，或读评论发现「我」已回过 |
| ➖ 无需回复 | `no_need` | 非提问帖 / 重复问题 / 早已回复过 |
| 🖐 需人工处理 | `manual` | 未命中答疑库 / 分数 0.45~0.75 / 敏感词 / 发送失败 / 找不到输入框 |
## 回复的 4 条铁律

| # | 规则 | 怎么落地 |
|---|---|---|
| 1 | **多次回复不要重复或雷同** | LLM 每次按上下文重新生成（`temperature 0.85`），天然不重样；历史和已发文本仍记账做参照 |
| 2 | **只能答答疑库里的内容，不能泄露别的** | 事实来源仍是 `qa/答疑库.md`（命中后整理成资料）；发送前过**泄露自检**（命中「答疑库/state.json/scripts/机器人/WAF/api key」等就拒发转人工） |
| 3 | **可以自己搜、自己组织话** | 社区已答 → 沉淀进库 → LLM 用自己的话讲（不照抄）；库里没有就按第 4 条处理 |
| 4 | **不知道 / 不能答的可以婉拒或不理会** | 提示词明确要求「拿不准就说拿不准，不许编造游戏数据」；默认**不理会**（转「🖐 需人工」） |

```bash
node scripts/test-variants.mjs       # 泄露自检（模板断言已删）
```
## 核心行为速查（细节见完整手册）
- **队列模式**：守护每 2 分钟重排一次，**每轮只处理队首一条**；手动跑 collect 才有「单轮最多 N 条」。
- **四类标记**：⏳未回复待回复 / ✅已回复 / ➖无需回复 / 🖐需人工处理。
- **求码帖**（天宫码/好友码）→ bot 全程静默，交人工版主；**加好友帖** → 管理任务固定回复，答疑侧不参与。
- **删评归人工**：bot 有删评能力但不使用。
- **签名**：`「版主助手-小鲸鱼」`，只由脚本追加一次，模型正文不写。
- **口吻**：玩家口气、短句口语、留轻话头；禁 AI 味/客服腔/公告腔。
- **不确定就弃答**：C7 judge 不达标 → 真提问转「需人工」、非提问「无需回复」，并进评测候选。
- **自治治理**：每日整理自动剔除 junk/噪声、合并近重复、零引用归档（只移动不删除）。
## 章节索引（完整手册目录）
- **目录结构** → [完整手册](references/skill-full.md) 内搜索该标题
- **快速开始** → [完整手册](references/skill-full.md) 内搜索该标题
- **做成常驻（登录即启动）** → [完整手册](references/skill-full.md) 内搜索该标题
- **守护循环：**2 分钟检查 + 队列**（新到旧，不打断当前）** → [完整手册](references/skill-full.md) 内搜索该标题
- **分发给其他成员** → [完整手册](references/skill-full.md) 内搜索该标题
- **答疑库会自动长大（社区已答 → 自动沉淀）** → [完整手册](references/skill-full.md) 内搜索该标题
- **答疑库生命周期（使用频次 + 归档）** → [完整手册](references/skill-full.md) 内搜索该标题
- **答疑库体检（每天自动，剔除自己的内容）** → [完整手册](references/skill-full.md) 内搜索该标题
- **说话的口吻：口语化 · 亲切 · 多样** → [完整手册](references/skill-full.md) 内搜索该标题
- **兑换码：好友码 vs 天宫码（**两种码，两种态度，绝不能混**）** → [完整手册](references/skill-full.md) 内搜索该标题
- **平台长度上限（硬约束，超了会被拒）** → [完整手册](references/skill-full.md) 内搜索该标题
- **回复怎么生成：LLM + 三层上下文（2026-11-04 起）** → [完整手册](references/skill-full.md) 内搜索该标题
- **互动续聊：玩家回话了，接着聊（2026-11-05）** → [完整手册](references/skill-full.md) 内搜索该标题
- **回复的 4 条铁律** → [完整手册](references/skill-full.md) 内搜索该标题
- **分享帖也去说说话（轻互动）** → [完整手册](references/skill-full.md) 内搜索该标题
- **纯情绪帖：只想要个回应，去陪一句（2026-11-10）** → [完整手册](references/skill-full.md) 内搜索该标题
- **签名：**默认必带，而且只由脚本加一次**** → [完整手册](references/skill-full.md) 内搜索该标题
- **多人协作：按**签名**识别「这帖回过没」** → [完整手册](references/skill-full.md) 内搜索该标题
- **玩家喊我们 → 过去互动一下** → [完整手册](references/skill-full.md) 内搜索该标题
- **版主管理任务：加好友帖 → 回固定文案 → 移除** → [完整手册](references/skill-full.md) 内搜索该标题
- **游戏评价（review）：接口能力已入库（2026-11-13）** → [完整手册](references/skill-full.md) 内搜索该标题
- **答疑库检索：从关键词匹配 → 向量检索** → [完整手册](references/skill-full.md) 内搜索该标题
- **帖子记录：state.json → SQLite** → [完整手册](references/skill-full.md) 内搜索该标题
- **四类标记** → [完整手册](references/skill-full.md) 内搜索该标题
- **是不是「提问」（决定要不要回）** → [完整手册](references/skill-full.md) 内搜索该标题
- **夸答题玩家（楼中楼）** → [完整手册](references/skill-full.md) 内搜索该标题
- **TapTap 表情（可用）** → [完整手册](references/skill-full.md) 内搜索该标题
- **问：什么时候能拿到新植物** → [完整手册](references/skill-full.md) 内搜索该标题
- **脚本一览** → [完整手册](references/skill-full.md) 内搜索该标题
- **答疑库格式** → [完整手册](references/skill-full.md) 内搜索该标题
- **问：钻石怎么快速获得** → [完整手册](references/skill-full.md) 内搜索该标题
- **问：月球基地打完只给12个粗制抑能吗** → [完整手册](references/skill-full.md) 内搜索该标题
- **数据与配置** → [完整手册](references/skill-full.md) 内搜索该标题
- **硬约束（踩过的坑）** → [完整手册](references/skill-full.md) 内搜索该标题
- **排障** → [完整手册](references/skill-full.md) 内搜索该标题
- **References** → [完整手册](references/skill-full.md) 内搜索该标题
- **附：2026-11-10 ~ 11-11 这一轮的改动清单（回顾）** → [完整手册](references/skill-full.md) 内搜索该标题
- **附：2026-11-12 联网补答（答疑库没命中 → 搜一次）** → [完整手册](references/skill-full.md) 内搜索该标题
---
*精简版生成于 2026-11-19（O8）；原文 1835 行完整保留在 references/skill-full.md。*
