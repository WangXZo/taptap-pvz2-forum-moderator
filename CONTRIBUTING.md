# 参与贡献

> 这个项目最缺的不是代码，是**答疑库内容**。补一条问答的价值 > 改十行代码。

## 答疑库在哪

**不随仓库分发** —— 每个人自己的库在运行目录：

```
~/.dsh/skills/taptap-pvz2-forum-moderator/qa/答疑库.md
```

- 新建：`cp assets/qa-library.example.md qa/答疑库.md`
- 格式见 [assets/qa-library.example.md](assets/qa-library.example.md)
- 守护进程会自动往里沉淀；每 24 小时体检一次，剔除带我们自己签名的脏条目

> 为什么仓库里不放：怕出现**旧版本副本**和**运行中版本**并存、互相覆盖。
> 历史上真出过 —— 一夜自动沉淀的 10 条被旧副本冲没了。

## ⚠️ 第 0 条：不要泄露他人信息

如果要把自己的答疑库内容提 PR（**注意：默认不要提**，先确认下面「提交前自查」）：

| 不要写 | 怎么写 |
|---|---|
| 玩家昵称 | 用「社区玩家」，或遮罩 `依******梦` |
| UID / user_id | 遮罩 `63****64` |
| QQ / 微信 / 群号 / 手机 / 邮箱 | 不写 |
| 自己的真实姓名 / 所在地 | 不写 |

**遮罩规则**：保留首尾各 1~3 位，中间用 `*` 替换，补足到统一 **8 位**（防止长度被推断），
保留字符不超过 50%。详见 [SKILL.md 的「脱敏规范」](SKILL.md)。

**来源链接要留** —— 那是可追溯性，不是个人信息。

## 一、补问答（最推荐）

### 三条硬要求

| # | 要求 | 为什么 |
|---|---|---|
| 1 | **关键词写玩家的口语**，把各种问法都列上 | 关键词是打分主依据 —— 写书面语等于匹配不上 |
| 2 | **答案用玩家口气写**，短句、口语 | 玩家一眼能看出是不是机器写的 |
| 3 | **事实必须准**，数字/名称/机制不能编 | 错答案会被自动发出去，比不回答更糟 |

**拿不准就别写。** 宁可空着，也不要污染库。

### 提交前自检

```bash
# 17 套回归测试全绿
node scripts/test-question.mjs && node scripts/test-praise.mjs && node scripts/test-variants.mjs && \
node scripts/test-match.mjs && node scripts/test-summarize.mjs && node scripts/test-archive.mjs && \
node scripts/test-qa-health.mjs && node scripts/test-summon.mjs && node scripts/test-mod-task.mjs && \
node scripts/test-api-contents.mjs && node scripts/test-qa-vector.mjs && node scripts/test-post-records.mjs && \
node scripts/test-removed-list.mjs && node scripts/test-limits-codes.mjs && node scripts/test-cold-store.mjs && \
node scripts/test-thread-context.mjs && node scripts/test-interact.mjs

node scripts/collect.mjs --dry-run   # 看新条目能不能被命中
node scripts/qa-admin.mjs purge-tag  # 确认没写进脏数据
```

## 二、改代码

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

1. **改行为必须加回归用例**。仓库里有 **17 套**测试（`test-*.mjs`），改完必须全绿。
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

## 三、提 PR 前自查

- [ ] 17 套测试全绿
- [ ] `node scripts/collect.mjs --dry-run` 正常
- [ ] `node scripts/qa-admin.mjs purge-tag` 没有脏条目
- [ ] 改行为的话加了回归用例
- [ ] 文档里没有悬空引用（删了脚本就删文档）
- [ ] 没有引入新的文案模板
- [ ] PR 描述写清楚「改了什么、为什么、怎么验证的」
