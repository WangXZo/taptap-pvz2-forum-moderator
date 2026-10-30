# 管理工具速查（答疑库 / 帖子）

> 两个 CLI，覆盖日常维护、诊断、灾备。路径全部来自 `scripts/config.json`，**跟着 skill 目录走**，拷给别人照样能用。
> 用法：`node scripts\qa-admin.mjs <子命令>` / `node scripts\post-admin.mjs <子命令>`

---

## 一、`qa-admin.mjs` —— 答疑库管理

### show　查看条目

```powershell
node scripts\qa-admin.mjs show                       # 列出全部
node scripts\qa-admin.mjs show --contains 塔黄        # 按关键词筛
node scripts\qa-admin.mjs show --source https://www.taptap.cn/moment/863832282933232344
```

输出里 `[人工]` / `[沉淀]` 区分来源，`[沉淀]` 的条目匹配分会自动打折 ×0.9。

### append　追加一条问答（手工维护）

```powershell
node scripts\qa-admin.mjs append `
  --source https://www.taptap.cn/moment/863832282933232344 `
  --question "买了塔黄无尽用什么好" `
  --keywords "塔黄,塔黄无尽,保龄球,神器,卡波,过波不流畅,心叶兰,二吸,空吸,一豆三旗" `
  --answer "直接买神器「保龄球」；卡波就塔黄空吸到最高再点下一波" `
  --from "枫******Zo（版主）"
```

- **原子读改写 + 按来源去重**：同一条来源重复执行不会写两遍
- 答案里的 `\n` 会还原成换行；长答案可用 `--answer-file answers.txt`
- ⚠️ 追加完**必须再跑一次 `register`**（见下），否则这条没有引用记录，30 天后会被归档

### keywords　改某条目的关键词

```powershell
node scripts\qa-admin.mjs keywords `
  --source https://www.taptap.cn/moment/863832282933232344 `
  --keywords "买了塔黄,塔黄无尽,保龄球,保龄球神器,无尽卡波,卡波怎么解,..."
```

匹配分数只认关键词（+ 问法相似度），**关键词写得好不好直接决定这条能不能被命中**。
写关键词的要点见 `references/question-detect.md` 与 SKILL.md「答疑库格式」。

### register　登记使用统计

```powershell
node scripts\qa-admin.mjs register `
  --source https://www.taptap.cn/moment/863832282933232344 `
  --question "买了塔黄无尽用什么好"
```

手工加的条目没有引用记录 → 归档器会当成「30 天未被引用」清掉。登记完就有 `createdAt`，归档才会算时间。

### rebuild　从来源重建（灾备）

```powershell
node scripts\qa-admin.mjs rebuild
node scripts\qa-admin.mjs rebuild --keep 863832282933232344,864050134038613015
```

- 依据 `data/qa-usage.json` 里记录的**来源链接**，重新抓社区回答，用同样的 `buildQaEntry` 重建沉淀条目
- 人工条目原样保留；`--keep` 里的来源也不重建（用于「手工精修过」的条目）
- **曾在答疑库被误覆盖时靠它全量找回**

### backup　手动备份

```powershell
node scripts\qa-admin.mjs backup     # → qa/答疑库.md.backup.md
```

守护进程**每轮都会自动备份**一次，这里只是手动补一份。

### purge-tag　剔除「携带自己标签」的条目

```powershell
node scripts\qa-admin.mjs purge-tag            # 只体检，不写文件
node scripts\qa-admin.mjs purge-tag --apply    # 真剔除（移到 qa/归档/）
node scripts\qa-admin.mjs purge-tag --tag 小鲸鱼   # 自定义要匹配的标签
```

**规则**：答疑库**不能**收自己发的夸奖 / 自己的回复。这类条目的特征就是正文里带着我们自己的签名
（当前是「版主助手-小鲸鱼」），所以按签名做判定。

| 行为 | 说明 |
|---|---|
| 判定范围 | 只查每条块 `---` **之后**的正文，元数据（来源/摘自）不参与 |
| 默认模式 | **只体检**，列出命中的条目，不动任何文件 |
| `--apply` | 先备份到 `qa/答疑库.md.before-purge-<日期>`，再把条目**移动**到 `qa/归档/答疑库-剔除自己标签-<日期>.md`，最后重写主库 |
| 不删除 | 归档文件永久保留，随时能拷回 `qa/答疑库.md` |

为什么要有这条命令：这是**反复发作**的问题 —— 沉淀逻辑（`scoreReply` 给版主 +4）曾把自己盖的夸奖楼
当成「最佳答案」收进库，导致库里的「答案」变成夸奖句。代码层已修（`buildQaEntry` 排除自己），
但还得有一个能随时复检、一键清理的入口。

#### 守护进程会**每天自动跑一次**

不需要手工执行 —— `collect.mjs` 第 0b 步会检查 `data/qa-usage.json` 的 `lastHealthAt`，
超过 `qaHealth.everyHours`（默认 **24**）才跑，命中即自动剔除并归档：

```
[体检] 答疑库干净（20 条，无自己标签条目）
[体检] 发现 2 条携带自己标签的条目：
  ✗ 《回忆之旅乱码》 命中「「版主助手-小鲸鱼」」
  已剔除并归档 → qa/归档/答疑库-剔除自己标签-20261028.md
  主库 22 → 20 条
```

配置（`scripts/config.json`）：

```json
"qaHealth": {
  "enabled": true,      // false = 彻底关掉
  "everyHours": 24,     // ⚠️ 用户要求「每天就行」，别调小；要更频繁先问
  "autoPurge": true     // false = 只报警，不动数据
}
```

实现只有一份：`lib/qa-health.mjs`（CLI 和守护进程共用，避免两处行为漂移）。
回归测试 `test-qa-health.mjs`（35 条断言）锁住：标签识别、只认正文、默认不写、
移动不删除、24 小时频率判断。

---

## 二、`post-admin.mjs` —— 帖子诊断与状态

### fetch　打印帖子的问答

```powershell
node scripts\post-admin.mjs fetch 863832282933232344 864096073424047526
```

输出格式：`[评论ID] 作者(作者ID)★我: 内容`，楼中楼用 `└` 缩进。
`★我` 标的就是你的账号 —— 用来挑「哪条是我答的」。

### mark-replied　标记「我已回复」

```powershell
node scripts\post-admin.mjs mark-replied 863832282933232344
```

你在帖子里**亲手回答过**的，跑一下，机器人就不会再去答同一帖（也不会再沉淀重复条目）。

### reset-praised / reset-share　重置标记

```powershell
node scripts\post-admin.mjs reset-praised 864120418414365903   # 夸奖发失败/误发后重试
node scripts\post-admin.mjs reset-share   864120418414365903   # 分享互动重试
```

### cleanup　按来源清理

```powershell
node scripts\post-admin.mjs cleanup https://www.taptap.cn/moment/863832282933232344
```

三处一起清：答疑库条目 + 使用统计 + 状态记录。
用来删掉「沉淀错了/垃圾条目」，比手工编辑三个文件稳。

### diag　命中率诊断

```powershell
node scripts\post-admin.mjs diag 10
```

打印每帖的最高匹配分、命中词比例、最接近的条目，以及各阈值下的命中数。

**读法**：

- 分数 **0.9 且标 `[沉淀]`** = 这条帖匹配的是**它自己的沉淀条目** → 不算真命中（那帖已被他人回答）
- 分数 **≤0.2** = 库里确实没有 → 照着 `reports/gaps.md` 补条目
- 分数**两极分布**（要么 0.9 要么 ≤0.2）说明**不是阈值问题，是覆盖面问题** → 调阈值没用

### recheck　用当前规则重判（专治旧帖错判）

```powershell
node scripts\post-admin.mjs recheck 863747312214608939            # 重判 + 沉淀答案（不发评论）
node scripts\post-admin.mjs recheck 863747312214608939 --praise   # 再加上：把楼中楼夸奖发出去
node scripts\post-admin.mjs recheck --all 500                    # 批量**预演**（不改状态）
node scripts\post-admin.mjs recheck --all 500 --apply            # 批量写入（⚠️ 只看标题，近似）
```

**为什么需要它**：规则改过之后，早先判错的帖子**不会自己翻案** ——
「翻案」只在扫描窗口内生效，老帖子早已滑出窗口，状态里的错判会永远留在报表里。

实例：「未来礼盒什么时候返场」在旧词表下缺「什么/返场」，被判成非提问帖，
其实是提问帖、而且已有玩家给出了有效回答。`recheck` 会：

1. 用**当前规则**重新判定 → `no_need/not_question` → `replied/others_replied`
2. 把那位玩家的有效回答**沉淀进答疑库**
3. （带 `--praise`）在**那条评论下面**夸一句 + 1 个表情

`--all` 批量模式**只看标题、不抓评论、不发任何内容**，专门用来扫出「旧规则错判」的帖子：

```
批量重判 82 个历史帖
发现 9 条判定有变化：
  《【官方攻略】…困难1-12攻略》  manual/no_qa_match → no_need/not_question
  《为什么火龙果无尽会清场》    manual/no_qa_match → manual/low_confidence
  《十月同游》                 manual/no_qa_match → no_need/not_question
```

**双向都能抓**：既抓漏判的提问帖（no_need → manual），也抓误判成提问的攻略帖（manual → no_need）。
扫完之后，对变化过的帖子逐个 `recheck <id> --praise` 补做沉淀与夸奖。

> ⚠️ **`--all` 只看标题，是近似的，默认只预演不改状态。**
> 守护进程用的是「标题 + 正文」判定，正文里可能还有「有没有人互换」这类疑问词 ——
> 实测「天宫码」就被批量改成 no_need、旋即被守护进程按正文翻回 manual。
> 要真正改状态用 `--apply`，但**准确做法是逐条 `recheck <id>`**（会抓评论、用完整文本判定）。

---

## 三、`probe-dom.mjs` —— 页面结构探针

TapTap 前端改版时（「找不到回复框 / 表情插不上 / 楼中楼点不开」），用它把当前 DOM 掏出来对照校准。
**只读探测，不会发送任何内容**（只点开输入框，不填字）。

```powershell
node scripts\probe-dom.mjs comment 863832282933232344 403560002   # 展开某条评论的楼中楼并 dump 结构
node scripts\probe-dom.mjs editor                               # 顶层评论框：输入框/工具栏/发送按钮
node scripts\probe-dom.mjs emoji                                # 表情面板全表（id + alt）
node scripts\probe-dom.mjs watch 863832282933232344 180        # 记录你的手动点击（3 分钟）
node scripts\probe-dom.mjs eval my.js                          # 跑任意 JS（stdout 干净）
```

`watch` 是排障利器：它记录你每次点击的元素路径（tag/class/祖先链）+ 面板状态变化，
**一眼就能看出「表情按钮到底是哪个 DOM 节点」** ——
当初定位 `span.tap-popover__trigger-wrap`（而不是 `label`）就是靠它。

> `watch` 依赖注入的 `window.__oc_clicks`，页面刷新后失效，重跑即可。

---

## 四、典型流程

### 看到一条好问题，想补进库

```powershell
node scripts\post-admin.mjs fetch <momentId>                 # 1. 看清问题与各位的回答
node scripts\qa-admin.mjs append --source <url> --question "…" --keywords "…" --answer "…" --from "…"   # 2. 追加
node scripts\qa-admin.mjs register --source <url> --question "…"                                            # 3. 登记（别忘！）
node scripts\post-admin.mjs diag 10                                                                              # 4. 验证命中率
```

### 手动答过的帖子，避免机器人重复答

```powershell
node scripts\post-admin.mjs mark-replied <momentId...>
```

### 每隔几天扩一次库

```powershell
node scripts\report-gaps.mjs --fresh 10     # → reports/gaps.md（未命中清单 + 高频主题词）
# 按清单补条目 → 重复上面的 append + register
```

### 出了事故要回退

```powershell
node scripts\restore-qa.mjs                # 看当前/备份条数
node scripts\restore-qa.mjs --restore      # 用备份覆盖当前
```

---

## 五、硬约束（别踩）

1. **答疑库的权威是「运行中」那份**（守护进程一直在往里沉淀）。
   同步方向只能是 **运行中 → 构建源/留档**；反向覆盖过一次，一夜沉淀的 10 条全丢。
2. **手工条目要 register**，否则会被归档。
3. **手工条目的关键词要口语化**，否则匹配不到（打分是饱和+长度加权，命中约 2 个实词即满分）。
4. **`cleanup` 是按来源链接删**，别手滑把别人的条目删了。
5. 这些工具都**会写文件**（答疑库 / 状态库 / 使用统计），在 `~/.dsh` 下，
   沙盒里跑会被拒，需要提权执行。
