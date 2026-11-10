# TapTap 论坛版主助手（植物大战僵尸2）

> 让 AI 帮忙盯 TapTap 论坛：**每 2 分钟**扫一次最新帖子 → 能答的用 LLM 按上下文答 →
> 答不了的整理成清单交给版主。社区里已经有人答过的，顺手把那份答案存进答疑库，
> 下次同类问题就能自动回。

```
┌─ 核心引擎（纯 Node，零第三方依赖）──────────────────────────────┐
│  watch（2 分钟检查 + 队列）/ collect / report / doctor / install   │
│  qa-admin（答疑库管理）/ post-admin（帖子诊断）/ cold-store（冷库）  │
│  lib/llm.mjs        ← 回复生成（复用 DSH 模型配置 or 自带 API Key） │
│  lib/thread-context ← 三层树状上下文（帖子→回复→楼中楼）           │
│  lib/cold-store     ← 帖子维度冷热分离（向量库 + 分类 TTL + 唤醒）  │
│  lib/interact       ← 玩家回信后的继续互动                         │
└───────────────────────────────────────────────────────────────┘
┌─ SKILL.md（给 AI 读）──────────────────────────────────────────┐
│  判断规则、三层上下文、口吻规范、51 条硬约束、踩坑清单、排障流程      │
└───────────────────────────────────────────────────────────────┘
```

> ⚠️ **回复是 LLM 现场生成的，一个模板都没有。**
> 措辞不再从文案池里挑，而是「三层上下文 + 答疑库资料 → 模型用自己的话讲」。
> 详见 [SKILL.md 的「回复怎么生成」](SKILL.md)。

---

## 这是给谁用的

| 你是 | 从哪开始 |
|---|---|
| **版主 / 答疑组成员** | 下面「三步跑起来」→ 然后用 `assets/qa-library.example.md` 建自己的答疑库 |
| **想用 AI 驱动它** | 看 [SKILL.md](SKILL.md)，让 AI 读它，它就知道该怎么判断、怎么说话 |
| **想改代码** | [CONTRIBUTING.md](CONTRIBUTING.md) |

## 答疑库在哪

**仓库里有一份脱敏副本**（`qa/答疑库.md`）—— 发布时由 `publish-repo.mjs` 自动脱敏后覆盖：
「摘自」的玩家昵称、好友码、天宫码都会被遮罩，答案正文保持可读。

你运行时用的是 **运行目录** 里那份：

```
~/.dsh/skills/taptap-pvz2-forum-moderator/qa/答疑库.md
```

- 新建：`cp assets/qa-library.example.md qa/答疑库.md`
- 格式见 [assets/qa-library.example.md](assets/qa-library.example.md)
- 守护进程会**自动往里沉淀**社区已答的问题（社区沉淀条目匹配分 ×0.9，低于人工条目）
- 每 24 小时体检一次，剔除「正文里带我们自己签名」的脏条目
- **想把自己的沉淀分享出去**：`node scripts/publish-repo.mjs --repo <仓库目录>`
  —— 它脱敏后写进仓库，并扫一遍个人信息（有真值就当场拦下）
- **想把仓库的新问答拿回运行目录**：`node scripts/qa-sync.mjs --to-runtime --apply`

> ⚠️ **永远不要手工用仓库副本覆盖运行中的库** ——
> 历史教训：一夜自动沉淀的 10 条被旧副本冲没了。

## 它会做什么、不会做什么

**会**：

- **守护循环**：每 **2 分钟**取一次最新帖 → 挑出要处理的并入队列 → 按发布时间**新→旧重排** → 一直处理队首；
  检查只在两条帖之间发生，**不打断当前**那条
- **LLM 生成回复**：三层树状上下文（帖子 → 一级回复 → 楼中楼）喂给模型，
  父级内容全带上；楼中楼 @ 了某人时，额外把**同层**那个人说过的话也带上
- **答疑库命中 → 先整理再当资料**：按当前话题挑出最相关的 1~2 句，标注「仅供参考，不许照抄」
- **玩家喊你**（签名 / 别名 / 「版主在吗」）→ 过去互动一次：敏感问题礼貌拒绝，其余顺着他的话接
- **玩家回信后继续互动**：@你 / 回复你 / 喊你 → 可以接一句；
  纯客套（「哈哈谢谢」）不回；同一帖同一玩家回过 1 次后降到 **50%** 概率，但情绪强烈必回
- **社区已有人答对 → 沉淀进答疑库 + 在楼中楼夸一句**（夸什么由 LLM 按上下文生成，夸到具体点上）
- **分享/进度/吐槽帖 → 去说句话**（不输出信息，只互动）
- **帖子维度冷热分离**：按类别 TTL 冷藏进**向量冷库**（加好友 1 天 / 提问 10 天 / 闲聊 15 天 /
  我的帖 20 天 / 分享 30 天 / 官方 60 天）；**自己的帖有人回**、**别人的帖有人 @我或呼唤我** → 自动唤醒回热数据
- **多人协作按签名识别「回过没」** → 队友回过的不会重复回
- **答疑库用向量检索**：相似度 = max(关键词+旧 dice, 向量相似度)；向量只加分不扣分、最多贡献 0.4 分
  —— **光靠向量永远触发不了自动回复**，不会误答
- **帖子记录落 SQLite**（逐行写）：多进程各写各的行，不会互相覆盖；老记录从 `state.json` 搬进库
- **好友码 vs 天宫码严格区分**：好友码 = `and/ios`+8 位（广告）；天宫码 = `JFA`+7 位（无私分享，该夸）
  —— 混了会把好帖当成广告删掉
- **版主管理任务**：检查**今天**的加好友帖（只管讨论区；活动报名板整块跳过）
  → 判定分两档：`clear`（明确意图）/ `uncertain`（只像好友码，只回复不删）
  → **「移除」动作默认关闭**（`modTasks.friendRequest.removeEnabled=false`）：
  识别照常、回复照常，帖子不移除；要恢复改成 `true`

**不会**（有硬性安全阀）：

- 不碰充值/退款/封号/举报类内容（礼貌说明帮不上，不替官方表态）
- 不泄露内部信息（发送前过泄露自检，命中就拒发转人工）
- 不编造游戏数据（拿不准就说拿不准）
- **不替官方承诺**、不贬低玩家
- 不发没有把握的内容（库里没有 → 转人工）
- 表情插不上就**不发送**，绝不发出错误内容
- **不承诺换码**（求天宫码只陪聊）

## 三步跑起来

```bash
# 0) 装依赖（只需一次）
npm i -g @jackwener/opencli
#    并在 Chrome 装 opencli 扩展、登录 TapTap

# 1) 一键安装 + 自检
node scripts/install.mjs
#    它会检查环境、补全配置、建目录，然后跑一遍 doctor

# 2) 先看效果（不发送）
node scripts/watch.mjs --dry-run

# 3) 真跑
node scripts/watch.mjs
```

跑起来后看 `reports/questions.md`（人看）和 `reports/questions.csv`（Excel）。

### 常用命令

```bash
node scripts/doctor.mjs                # 自检：环境/配置/LLM 渠道/分层唤醒/冷热分类/互动规则
node scripts/whoami.mjs                # 拿自己的 user_id（填进 config.json）
node scripts/collect.mjs --dry-run     # 只跑一轮，不常驻、不发送
node scripts/qa-admin.mjs show         # 看答疑库有哪些条目
node scripts/qa-admin.mjs append ...   # 手工加一条问答
node scripts/qa-admin.mjs purge-tag    # 体检：有没有带自己标签的脏条目
node scripts/qa-admin.mjs purge-junk   # 体检：有没有广告/灌水条目
node scripts/post-admin.mjs recheck <id>   # 老帖子判定错了，重新判
node scripts/post-admin.mjs check-removed <id>  # 这帖还在不在版块里
node scripts/mod-task.mjs --dry-run    # 版主管理任务：只判定不移除
node scripts/mod-watch.mjs              # 版主管理任务常驻（检查每 2 分钟）
node scripts/api-write.mjs probe        # 写接口连通性自检（假 id，无副作用）
node scripts/api-write.mjs comments <id>  # 看某帖评论区
node scripts/qa-index.mjs build         # 重建答疑库向量索引
node scripts/qa-index.mjs query "无尽卡波"  # 试检索，看召回对不对
node scripts/cold-store.mjs stats        # 冷库统计（按类别）
node scripts/cold-store.mjs search "困难6怎么过"  # 向量检索冷库
node scripts/cold-store.mjs wake <id>    # 手动把冷帖搬回热数据
node scripts/post-records.mjs stats     # 帖子记录库统计
node scripts/emoji-map.mjs              # 采集「表情名 → id」表
node scripts/report-gaps.mjs            # 生成「待补充问题清单」
```

### 自检（改规则前后必跑，20 套）

```bash
node scripts/test-question.mjs && node scripts/test-praise.mjs && node scripts/test-variants.mjs && \
node scripts/test-match.mjs && node scripts/test-summarize.mjs && node scripts/test-archive.mjs && \
node scripts/test-qa-health.mjs && node scripts/test-summon.mjs && node scripts/test-mod-task.mjs && \
node scripts/test-api-contents.mjs && node scripts/test-qa-vector.mjs && node scripts/test-post-records.mjs && \
node scripts/test-removed-list.mjs && node scripts/test-limits-codes.mjs && node scripts/test-cold-store.mjs && \
node scripts/test-thread-context.mjs && node scripts/test-interact.mjs && node scripts/test-publish-mask.mjs && \
 && node scripts/test-comfort.mjs
```

## LLM 从哪来

两条路，都支持：

| 场景 | 怎么配 | 效果 |
|---|---|---|
| **自己用** | `config.llm` 留空 | 复用 DSH 的模型配置（`~/.dsh/profiles/web/cordis.patch.yml` + `.credentials.yaml`），跟着你在 GUI 里切的模型走 |
| **给别人用** | 填 `config.llm.apiKey / baseURL / model` | 用自己的 Key，不碰 DSH 配置 |

渠道按实测快慢排序，失败（429/超时/空正文）自动切下一条。
**生成失败 → 转人工，绝不退回模板**（没有模板可退）。

## 回复长什么样

**答一个问题**（事实来自答疑库，措辞是模型自己的）：

```
困难6的关键是先控住。用冰车冻住前排，再上机枪输出，40级左右就能过。

「版主助手-小鲸鱼」[表情_点赞]
```

**夸一个答题好的玩家**（楼中楼）：

```
玩家B：困难6用机枪加冰车就行，我40级通关了
  └ 我们：一句「新号」就把话说到根上了，这判断比我翻半天攻略还快，学到了。 「版主助手-小鲸鱼」[表情_点赞]
```

**玩家回信了，接着聊**（同层楼中楼，@ 对方）：

```
玩家B：按你说的试了，还是打不过
  └ 我们：@玩家B 那可能差在冰车阶数，先升到三阶再试试，我当初也是二阶卡了很久
```

口吻规范：短句、口语、可以调侃、像老玩家在群里聊天。
**「不重样」靠三件事**（不是模板池）：LLM 按当前上下文重新生成 /
最近说过的话喂进提示词让模型避开 / 跨天去重（`praise_reply` 表）。
玩家是会把版主所有回复翻一遍的 —— 所以**不要模板化**。

## 怎么部署成常驻

Windows 上做不了系统服务（服务跑在 Session 0，看不到桌面 Chrome），
所以用**计划任务 + 登录时启动**：

```powershell
node scripts\schedule.ps1 -Action install
node scripts\schedule.ps1 -Action doctor
```

代价：机器得保持登录（锁屏可以，注销/关机不行）。详见 [references/ops.md](references/ops.md)。

## 多人协作须知

| 事实 | 后果 |
|---|---|
| 每个人的 `data/state.json` 独立 | A 回过哪些帖 B 不知道 → **同一问题可能被多人各回一遍** |
| `myUserId` 各不相同 | 互相判断不出「我已回过」（**靠签名兜住**：签名结尾的回复一律算「我们回过」） |
| 答疑库各自一份 | 答案口径可能不一致 —— 想要统一就共用一份库文件 |

**结论：能多人用，但只能有一个账号开自动回复**，其他人用 `--no-reply` 只采集出报表。

> 「移除加好友帖」是版主动作（当前默认关闭），多人同时开容易重复动同一帖 ——
> 建议只让一个账号开 `modTasks.enabled`。

## 文档

| 文件 | 内容 |
|---|---|
| [SKILL.md](SKILL.md) | **给 AI 读**：判断规则、三层上下文、口吻规范、51 条硬约束、踩坑清单 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 怎么改代码、怎么提 PR、代码约定 |
| [references/](references/) | 接口 / 表情 / 选择器 / 提问判定 / 喊话识别 / 夸答玩家 / 版主任务 / 运维 / 管理工具 |
| [docs/方案.md](docs/方案.md) | 初版方案与可行性边界（**历史文档，部分内容已过期**） |
| [docs/github-survey.md](docs/github-survey.md) | GitHub 上有没有能用的现成项目（调研存档） |

## 已知限制

- **必须有桌面会话**：要一个**已登录 TapTap 的 Chrome**（接口请求在页面里发，Cookie 由浏览器带）
- **接口有阿里云 WAF**：探测太密会封 IP（实测 >25 分钟不恢复）。默认 2 分钟一轮，被拦会自动退避
- **TapTap 官方 CLI 是只读的**：写操作走的是**网页版自己的私有接口**（非官方文档，随时可能变）；
  接口失败会自动退回点 UI，不会整条流水线停摆
- **楼中楼也走接口**（`create-child`，参数是 `parent_id`，已用真实请求校准）；
  猜错参数名会把回复变成**顶层评论**，所以校验要同时看「一级评论数变没」+「child_posts 里有没有我们那条」
- **接口回复是纯文本**：表情靠 `tap_emoji` 节点（需先跑一次 `emoji-map.mjs` 采 id 表）

## 许可

MIT —— 见 [LICENSE](LICENSE)。
