# 参与贡献

> 这个项目最缺的不是代码，是**答疑库内容**。补一条问答的价值 > 改十行代码。
> 所以第一件事：去 [qa/待补充问题.md](qa/待补充问题.md) 认领一条。

## ⚠️ 第 0 条：不要泄露他人信息

**这个仓库是公开的，`qa/答疑库.md` 里的每个字全网可搜。**

| 不要写 | 怎么写 |
|---|---|
| 玩家昵称 | 用「社区玩家」，或遮罩 `依******梦` |
| UID / user_id | 遮罩 `63****64` |
| QQ / 微信 / 群号 / 手机 / 邮箱 | 不写 |
| 自己的真实姓名 / 所在地 | 不写 |

**遮罩规则**：保留首尾各 1~3 位，中间用 `*` 替换，补足到统一 **8 位**（防止长度被推断），
保留字符不超过 50%。详见 [SKILL.md 的「脱敏规范」](SKILL.md#-脱敏规范所有贡献者必读)。

**来源链接要留** —— 那是可追溯性，不是个人信息。

## 一、补问答（最推荐）

### 认领 → 写 → 提 PR

1. 在 [qa/待补充问题.md](qa/待补充问题.md) 的「待补充」表里找一条你答得上来的，
   在「我的认领」区写一行 `- [x] #编号 标题 —— @你的GitHub名（2026-10-28）`
2. 按 [问答格式](qa/待补充问题.md#问答格式) 往 `qa/答疑库.md` 加条目
3. 跑自检（见下），三条都过
4. 提 PR，描述里写「补的是清单第几条 + 答案依据」

### 三条硬要求

| # | 要求 | 为什么 |
|---|---|---|
| 1 | **关键词写玩家的口语**，把各种问法都列上 | 关键词是打分主依据 —— 写书面语等于匹配不上 |
| 2 | **答案用玩家口气写**，短句、口语 | 玩家一眼能看出是不是机器写的 |
| 3 | **事实必须准**，数字/名称/机制不能编 | 错答案会被自动发出去，比不回答更糟 |

**拿不准就别写。** 宁可空着，也不要污染库。

### 提交前自检

```bash
node scripts/test-question.mjs && node scripts/test-praise.mjs && node scripts/test-variants.mjs && \
node scripts/test-match.mjs && node scripts/test-summarize.mjs && node scripts/test-archive.mjs && \
node scripts/test-qa-health.mjs && node scripts/test-summon.mjs && node scripts/test-mod-task.mjs && \
node scripts/test-api-contents.mjs && node scripts/test-qa-vector.mjs && node scripts/test-post-records.mjs

node scripts/collect.mjs --dry-run   # 看新条目能不能被命中
node scripts/qa-admin.mjs purge-tag  # 确认没写进脏数据
```

## 二、改代码

### 目录

```
scripts/            入口脚本（CLI）
scripts/lib/        核心模块
  http.mjs          读接口
  taptap-api.mjs    写接口直连（回复/移除，页面内 fetch）
  db.mjs            SQLite 底座（post_record / post_event / qa_vec）
  post-records.mjs  帖子记录读写 + 老记录搬库
  qa-vector.mjs     向量检索（分词 / TF-IDF / 余弦 + 覆盖率）
  qa.mjs            答疑库解析 + 打分（含向量相似度项）
  classify.mjs      四类判定
  variants.mjs      回复文案（口吻）
  praise.mjs        夸奖文案
  summarize.mjs     社区答案沉淀
  qa-health.mjs     答疑库体检（剔除自己标签）
  emoji.mjs         TapTap 表情点选
  replier.mjs       opencli 驱动
  reply-nested.mjs  楼中楼回复
  state.mjs usage.mjs archive.mjs report.mjs paths.mjs util.mjs
references/         参考文档（改行为前先读对应那份）
qa/答疑库.md         ★ 协作核心
```

### 约定

1. **改行为必须加回归用例**。仓库里有 12 套测试（`test-*.mjs`），改完必须全绿。
   判定/打分/文案规则尤其如此 —— 这些规则是靠用例锁住的。
2. **事实来源只有 `qa/答疑库.md`**。脚本里不许硬编码游戏数值。
3. **文案改动要过口吻护栏**。测试里有一组断言（「没有客服腔」「没有公文腔」「池子 ≥15 套」
   「连着发不许重样」），改模板前先读那几条。
4. **优先复用，不要各写一份**。发现同样的函数出现在两个文件里，就是该抽到 `lib/` 的时候。
   （历史上 `entryKeyOf` 有三份、`hashOf` 有两份，都是这么清掉的。）
5. **删代码要连带删文档**。`SKILL.md` 和 `references/` 里提到的东西，别留下悬空引用。

### 改完怎么验证

```bash
node scripts/doctor.mjs            # 环境/配置/数据体检
node scripts/collect.mjs --dry-run # 跑一轮看看
```

## 三、答疑库的两份副本（最容易踩的坑）

| 副本 | 谁在写 | 怎么改 |
|---|---|---|
| 仓库 `qa/答疑库.md` | **人**（PR） | 直接改，提 PR |
| 运行中 `~/.dsh/skills/.../qa/答疑库.md` | **守护进程**（自动沉淀） | 不手改 |

两边会同时长。合并工具：

```bash
node scripts/qa-sync.mjs --status        # 看差异
node scripts/qa-sync.mjs --to-repo --apply    # 运行中的自动沉淀 → 仓库
node scripts/qa-sync.mjs --to-runtime --apply # 仓库的新问答 → 运行中
```

**永远不要直接覆盖。** 历史上曾用旧副本覆盖运行中的库，一夜之间自动沉淀的 10 条全丢。

## 四、提 PR 前自查

- [ ] 12 套测试全绿
- [ ] `node scripts/collect.mjs --dry-run` 正常
- [ ] `node scripts/qa-admin.mjs purge-tag` 没有脏条目
- [ ] 改行为的话加了回归用例
- [ ] 改文案的话过了口吻护栏
- [ ] 文档里没有悬空引用（删了脚本就删文档）
- [ ] PR 描述写清楚「改了什么、为什么、怎么验证的」
