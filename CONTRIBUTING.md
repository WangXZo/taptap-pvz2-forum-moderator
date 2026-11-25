# 参与贡献

> 这个项目最缺的不是代码，是**答疑库内容**。补一条问答的价值 > 改十行代码。

## 答疑库在哪

**仓库里有一份脱敏副本**（`qa/答疑库.md`，发布时自动脱敏写入）；
你自己跑的时候用的是 **运行目录** 里那份：

```
~/.dsh/skills/taptap-pvz2-forum-moderator/qa/答疑库.md
```

2026-11-25 起，答疑库有两种形态：

| 形态 | 位置 | 说明 |
|---|---|---|
| **一条一文件**（新，主用） | `qa/entries/<id>.md` | 多人同时加条目**不撞 git 冲突**，PR diff 一条一文件看得清 |
| 单文件（兼容期） | `qa/答疑库.md` | 旧形态，运行时自动优先读条目目录；目录空时退回单文件 |

- 新条目一律进 `qa/entries/`
- 格式见 [assets/qa-library.example.md](assets/qa-library.example.md) 与 `qa/entries/` 里现成的条目
- 守护进程会自动往里沉淀；每 24 小时体检一次，剔除带我们自己签名的脏条目
- **想把沉淀分享到仓库**：跑 `node scripts/publish-repo.mjs --repo <仓库目录>`
  —— 自动遮罩「摘自」昵称 / 好友码 / 天宫码，并扫个人信息
- **想把仓库的问答拿回来**：`node scripts/qa-sync.mjs --to-runtime --apply`

> ⚠️ **永远不要手工用仓库副本覆盖运行中的库**。
> 历史教训：一夜自动沉淀的 10 条被旧副本冲没了。

## 协作方式速览

| 改什么 | 怎么走 | 要评审吗 |
|---|---|---|
| **补一条问答** | `qa-admin submit` → 落到 `qa/entries/` → 每日合并 | ❌ 不用（质量闸自动过） |
| **改代码** | 分支 `feat/*` `fix/*` `chore/*` → PR → CI 必须过 | ✅ 1 人 approve |
| **写经验** | 加到 `playbook/<主题>.md` → PR | ✅ 1 人 approve |

**答疑库免 PR 直提**：内容价值高、风险低，所以走免 PR 通道 ——
但**高置信度要点（≥90）永远不会被自动改写**，新答案只能作为**补充要点**并列；
有矛盾时会标出来等人看。详见 [playbook/答疑库治理.md](playbook/答疑库治理.md)。

**每日合并**：在 `config.collab.merge.window`（默认 02:00~05:00，本地时间）内**随机**取一个时刻执行，
避开多人同时拉取/提交。合并来源是四路：GitHub main + GitHub `contrib/*` 分支 + 本地运行副本 + 本地真源。


## ⚠️ 第 0 条：不要泄露他人信息

答疑库会**脱敏后**进仓库，但你自己写条目时仍然要守规矩（别指望脚本兜底）：

| 不要写 | 怎么写 |
|---|---|
| 玩家昵称 | 用「社区玩家」，或遮罩 `依******梦` |
| UID / user_id | 遮罩 `63****64` |
| QQ / 微信 / 群号 / 手机 / 邮箱 | 不写 |
| 自己的真实姓名 / 所在地 | 不写 |
| 好友码 / 天宫码 | 不写（发布时会自动遮罩，但别依赖它） |

**遮罩规则**：保留首尾各 1~3 位，中间用 `*` 替换，补足到统一 **8 位**（防止长度被推断），
保留字符不超过 50%。详见 [SKILL.md 的「脱敏规范」](SKILL.md)。

**来源链接要留** —— 那是可追溯性，不是个人信息。

## 一、补问答（最推荐）

### 提交方式（一条命令）

```bash
# 推荐：答案写文件，避免命令行转义地狱
node scripts/qa-admin.mjs submit --question "买了塔黄无尽用什么好" --answer-file 答案.md

# 也行：直接给答案
node scripts/qa-admin.mjs submit --question "…" --answer "…"

# 常用开关
--source <URL>     # 来源链接（可追溯性，不是隐私）
--keywords a,b,c   # 关键词（口语各种问法都列上）
--no-split         # 不调 LLM 拆要点，整段当一个要点
--dry-run          # 只看结果不写
```

提交后会自动做这些事：

1. **质量闸**：垃圾（求码/加好友/广告）、自签名、手机号/邮箱/QQ、昵称与好友码 → 拦下并说明原因
2. **自动拆要点**：一段答案拆成 1~6 个**可独立评价**的具体点
3. **合并**：同问题已有条目 → 并入要点（不覆盖原要点）；不同问题 → 新建条目文件
4. **原子写入** `qa/entries/<id>.md`（排他创建，不覆盖别人的）

### 条目长什么样

```markdown
---
id: q-tahuang-wujin-dapei
question: 买了塔黄无尽用什么好
keywords: [塔黄, 保龄球, 卡波]
version: 通用
confidence: 70
updated: 2026-11-25
source: https://www.taptap.cn/moment/863832282933232344
---

## 要点
- [70%] 优先买神器保龄球
  - 来源: https://www.taptap.cn/moment/863832282933232344
- [50%] 卡波建议塔黄空吸到最高再点下一波
  - 来源: https://www.taptap.cn/moment/863999999999999999
```

**要点（claim）的纪律**：

| # | 要求 | 为什么 |
|---|---|---|
| 1 | 一个要点 = 一个**可独立评价**的具体说法 | 没法单独评价的就不叫要点 |
| 2 | 不拆成词/短语，也别把两件无关的事塞一起 | 拆太碎没法用，拆太粗没法分别评估 |
| 3 | 数字、名称、机制**原样保留** | 那是事实核验的对象，改写就失真 |
| 4 | 一段答案 1~6 条 | 本来就一句话就只给 1 条 |

**id 纪律**：id 由问法 slug 生成后**固化在文件里**，问法改了 id 不变（改了 id 会被当成新条目）。
同 id 但来源不同 → 说明是两条不同的，拆开用不同 id。

**置信度纪律**：

| 情况 | 置信度 |
|---|---|
| 官方来源 / 人工核实 | 95（可信） |
| >3 个独立渠道且 ≥3 个玩家说法一致 | 80（高） |
| ≥2 个独立渠道一致 | 70（高） |
| 单一社区来源 | 50（中） |
| 有未解决的反对票 | 30（低） |

社区沉淀**最高只到高置信度**，可信档只给官方资料和人工确认。

### 三条硬要求

| # | 要求 | 为什么 |
|---|---|---|
| 1 | **关键词写玩家的口语**，把各种问法都列上 | 关键词是打分主依据 —— 写书面语等于匹配不上 |
| 2 | **答案用玩家口气写**，短句、口语 | 玩家一眼能看出是不是机器写的 |
| 3 | **事实必须准**，数字/名称/机制不能编 | 错答案会被自动发出去，比不回答更糟 |

**拿不准就别写。** 宁可空着，也不要污染库。

### 提交前自检

```bash
# 20 套回归测试全绿
node scripts/test-question.mjs && node scripts/test-praise.mjs && node scripts/test-variants.mjs && \
node scripts/test-match.mjs && node scripts/test-summarize.mjs && node scripts/test-archive.mjs && \
node scripts/test-qa-health.mjs && node scripts/test-summon.mjs && node scripts/test-mod-task.mjs && \
node scripts/test-api-contents.mjs && node scripts/test-qa-vector.mjs && node scripts/test-post-records.mjs && \
node scripts/test-removed-list.mjs && node scripts/test-limits-codes.mjs && node scripts/test-cold-store.mjs && \
node scripts/test-thread-context.mjs && node scripts/test-interact.mjs && node scripts/test-publish-mask.mjs && \
 && node scripts/test-comfort.mjs

node scripts/collect.mjs --dry-run   # 看新条目能不能被命中
node scripts/qa-admin.mjs purge-tag  # 确认没写进脏数据
```

## 二、改代码

### 分支与 PR

```
main              ← 受保护，只能通过 PR 合入
feat/xxx          ← 新功能
fix/xxx           ← 修 bug
chore/xxx         ← 杂活（文档、脚本）
contrib/<你>-<日期>  ← 答疑库内容直提（免 PR，由每日合并自动并入 main）
```

- **代码改动必须走 PR**：CI 必须全绿（回归测试 + 条目格式校验 + 隐私扫描），1 人 approve 后合 main
- **答疑库内容免 PR**：落到 `qa/entries/` 即可，每日合并会自动汇入（高置信度要点不会被自动改写）
- 一个 PR 只做一件事；描述写清楚「改了什么、为什么、怎么验证的」

### 目录

```
scripts/            入口脚本（CLI）
scripts/lib/        核心模块
  http.mjs          读接口（WAF 退避）
  taptap-api.mjs    写接口直连（回复/楼中楼/移除，页面内 fetch）
  db.mjs            SQLite 底座（post_record / post_event / qa_vec / post_cold）
  post-records.mjs  帖子记录读写 + 老记录搬库
  qa-vector.mjs     向量检索（分词 / TF-IDF / 余弦 + 覆盖率）
  qa.mjs            答疑库解析 + 打分（含向量相似度项）
  classify.mjs      四类判定
  compose-reply.mjs 回复生成（LLM）：人设 + 三层上下文 + 资料整理 + 三道护栏
  llm.mjs           LLM 客户端（复用 DSH 配置 or 自带 Key，失败自动切渠道）
  thread-context.mjs 三层树状上下文（父链 + @ 平级扩展）
  cold-store.mjs    帖子维度冷热分离（向量冷库 + 分类 TTL + 分层唤醒）
  notify.mjs        通知接口（回复/@我收到的）→ 冷帖唤醒 + 互动信号
  interact.mjs      互动续聊判定（候选 / 纯客套 / 降概率 / 层级）
  interact-send.mjs 互动续聊发送（与喊话通道分开记账）
  summarize.mjs     社区答案沉淀
  qa-health.mjs     答疑库体检（剔除自己标签）
  praise.mjs        夸奖对象挑选
  praise-store.mjs  夸奖沉淀（回答 ↔ 夸奖 成对留档 + 向量）
  praise-send.mjs   夸奖发送
  summon.mjs        喊话护栏（assertKind）
  summon-send.mjs   喊话发送
  variants.mjs      泄露自检（assertNoLeak）
  code-guard.mjs    好友码 / 天宫码分类 + 换码承诺护栏
  limits.mjs        平台长度上限（标题 30 / 内容 50000 / 回复 1000）
  signature.mjs     签名识别（我们回过没 / 玩家在喊我们）
  emoji.mjs         TapTap 表情点选
  replier.mjs       opencli 驱动
  reply-nested.mjs  楼中楼回复
  state.mjs usage.mjs archive.mjs report.mjs paths.mjs util.mjs
references/         参考文档（改行为前先读对应那份）
```

### 约定

1. **改行为必须加回归用例**。仓库里有 **20 套**测试（`test-*.mjs`），改完必须全绿。
   判定/打分/文案规则尤其如此 —— 这些规则是靠用例锁住的。
2. **事实来源只有 `qa/答疑库.md`**。脚本里不许硬编码游戏数值。
3. **不许加文案模板**。措辞一律由 LLM 按上下文生成（`lib/compose-reply.mjs`）。
   要防重样，用 `avoidTexts` + `praise-store.mjs` 的历史文本，**不要**建模板池。
4. **优先复用，不要各写一份**。发现同样的函数出现在两个文件里，就是该抽到 `lib/` 的时候。
   （历史上 `entryKeyOf` 有三份、`hashOf` 有两份，都是这么清掉的。）
5. **删代码要连带删文档**。`SKILL.md` 和 `references/` 里提到的东西，别留下悬空引用。
6. **新功能保持独立、低耦合**。判定 / 生成 / 发送三段分开成模块
   （参考 `interact.mjs` + `compose-reply.mjs` + `interact-send.mjs` 的分工），
   记账键也要分开，别让两个通道互相误伤。

### 改完怎么验证

```bash
node scripts/doctor.mjs            # 环境/配置/LLM 渠道/分层唤醒/冷热分类/互动规则
node scripts/collect.mjs --dry-run # 跑一轮看看
```

## 三、写经验（别让踩过的坑只留在自己脑子里）

`playbook/` 按**主题**组织，不按人 —— 谁踩到就当场写一条，提 PR：

```
playbook/踩坑.md        沙盒 EPERM、TLS 被 RST、PS 5.1 编码、无 BOM 乱码
playbook/答疑库治理.md  怎么写一条好条目、何时归档、要点拆分与合并
playbook/识图调优.md    VLM 渠道排序、耗时基线、JSON 截断抢救
playbook/运营SOP.md     每日流程、异常处置、额度与刹车
```

- 写**具体做法 + 具体命令 + 具体数字**，别写「要谨慎」这种空话
- 每条要有现象 / 原因 / 做法，能让别人照着做

## 四、提 PR 前自查

- [ ] 全部测试绿（`npm test`）
- [ ] 条目格式校验过（`node scripts/qa-lint.mjs`）
- [ ] `node scripts/collect.mjs --dry-run` 正常
- [ ] `node scripts/qa-admin.mjs purge-tag` 没有脏条目
- [ ] 改行为的话加了回归用例
- [ ] 文档里没有悬空引用（删了脚本就删文档）
- [ ] 没有引入新的文案模板
- [ ] PR 描述写清楚「改了什么、为什么、怎么验证的」
