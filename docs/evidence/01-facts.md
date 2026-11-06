# 事实核验记录（2026-10-26 12:12）

## 1. taptap-cli 安装
- 命令：`npm i -g @taptap/cli --registry=https://registry.npmjs.org/`
- 结果：added 7 packages in 13s
- 版本：`taptap-cli version` → @taptap/cli **2026.10.25**，contract 3，skills catalog 1.0.59
- 全局路径：`D:\npm-global\node_modules\@taptap\cli`
- 已内置 12 个官方 AI Skill（skills list 输出见 work 目录）

## 2. taptap-cli 社区能力边界（关键）
`taptap-cli community-management --help` 仅 8 个方法，**全部只读**：
- list-community-moments / get-community-moment
- list-community-moment-replies / list-community-moment-child-replies
- list-community-group-labels
- get-community-moment-video-upload-token / complete-community-moment-video-upload / upload-community-moment-image

官方 skill 原文结论：
> 要发帖、回帖、置顶、加精、删除或处理内容 → **CLI 不支持写；说明只能查看，不要承诺已处置**

schema 还显示 list-community-moments 支持 `moment_intent`：**1=问答求助，2=反馈建议**，且按「论坛管理中心批量管理」口径可见。
→ 这正是"命中问题列表"的官方筛选维度，但需要 **developer_id + app_id 的开发者权限**。

## 3. taptap-cli 运行障碍（本机）
- `taptap-cli auth status` 失败：`failed to save TapTap config C:\Users\Wa****XZ\.taptap-cli\taptap.json`
  → 配置写在家目录，DSH 工作区沙盒（workspace-write）拒绝；需要 danger-full-access 或大哥在普通终端自行登录。
- `taptap-cli auth login` 需要大哥本人在浏览器完成 TapTap 账号授权，agent 无法代做。

## 4. 社区公开接口逆向（官方前端 bundle 提取）
从 `https://assets.tapimg.com/apps/web-app-next/_nuxt/webapiv2.BBQjoOMe.js` 提取到 1557 条 webapiv2 路径，其中关键：
| 用途 | 路径 | 方法 |
|---|---|---|
| 论坛帖子流 | `/webapiv2/feed/v7/by-group` | GET |
| 按 App 帖子流 | `/webapiv2/feeds/v2/by-app`、`/feeds/v3/by-app` | GET |
| 论坛内搜索 | `/webapiv2/forum-feed-search/v1/by-keyword` | GET |
| 帖子回复列表 | `/webapiv2/creation/comment/v1/by-post` | GET |
| **发回复** | `/webapiv2/creation/comment/v1/create` | POST (UrlEncoded) |
| **回复楼中楼** | `/webapiv2/creation/comment/v1/create-child` | POST (UrlEncoded) |
| 删除回复 | `/webapiv2/creation/comment/v1/delete` | POST |

### 已验证：匿名可读（无需登录）
请求：
`GET https://www.taptap.cn/webapiv2/feed/v7/by-group?from=0&group_id=40173&limit=10&sort=default&status=0&type=feed&with_hot_comment=true`
- 必带 header `X-UA: V=1&PN=WebApp&LANG=zh_CN&VN_CODE=102&VN=3.62.0&LOC=CN&PLT=PC&DS=Android&UID=0&OS=Windows&OSV=10&DT=PC&CH=chrome`
- 实测返回：`success:true`，`total:20`，`list:10` 条真实帖子，98,664 字节
- **PVZ2 论坛 group_id = 40173**（app_id 54031 与 group_id 不同）
- 未带 X-UA → `INVALID_XUA`；`feeds/v2/by-app` 匿名返回空列表（需登录态）
- 抓取到的页面 HTML（475KB，Nuxt SSR）内已含帖子列表数据，可作为二次校验源

### 帖子数据结构（实测字段）
```
item.moment.id_str        帖子ID（字符串，19位，必须按字符串处理）
item.moment.topic.title   标题（长贴有，图文动态为 null）
item.moment.topic.summary 正文摘要
item.moment.topic.type    1=长贴  2=图文动态
item.moment.topic.id_str  topic id
item.moment.publish_time  Unix 秒
item.moment.commented_time 最后回复时间（Unix 秒）
item.comment_count        回复数（0 时字段被省略）
item.moment.stat.pv_total / ups / play_total
item.moment.author.user.name / id / is_moderator
item.moment.group_label   子版块（可为空）
```

### 写操作（回复）风险
- POST 端点需登录态 Cookie（`taptap_session` 等），可能还需 `X-Request-Id` / 签名。
- 属于自动化写社区内容：存在社区规则、账号风控、误回复风险 → 方案必须默认 dry-run + 限流 + 人工闸门。

## 5. 结论
- **读**：匿名接口可稳定拿到帖子流（已实测）；有开发者权限时 taptap-cli 还能拿到官方「问答求助」意图标签。
- **写**：官方无接口。只能走（A）浏览器自动化复用大哥登录态，或（B）网页接口 + Cookie，或（C）半自动人工点发。

---

## 6. 运行期实测发现（补充，2026-10-26 12:31）

### 6.1 接口参数硬限制
- `feed/v7/by-group` 的 `limit` **最大 10**（15/20 直接返回 `Field validation for 'limit' failed on the 'max' tag`）
- `sort` 只接受 `default` / `hot`；`created_at` / `rank` 报 `sort failed`
- 分页 `from` 是 offset，但 default 排序每次重排 → **翻 4 页 40 条去重后仅 16 条唯一帖**（推荐流特性）

### 6.2 阿里云 WAF（关键运维约束）
连续探测约十余次后，`feed/v7/by-group` 开始返回：

```
<!doctype html><meta name="aliyun_waf_aa" content="...">
```

- **HTTP 200 但内容是 HTML**，不是 JSON
- curl 与 Node fetch **同时被拦** → 判定为 **IP 级封禁**
- 等待 90 秒未恢复；退避 15s/30s/45s 三轮重试均失败
- 结论：匿名接口必须**低频**（页间隔 ≥2.5s、单次 ≤8 页、每日 ≤3 次）
- 浏览器（真实 Chrome + 登录 Cookie）不受该 WAF 影响 → 作为兜底通道

### 6.3 浏览器通道可用性
- opencli v1.8.0，daemon 端口 19825
- 首次 `doctor` 报 `Extension: not connected`；执行 `opencli daemon restart` 后 → `Extension: connected (v1.0.26)`，profile `w75cn5cx`
- 可正常 `bind` / `open` / `eval` / `tab list`
- 打开 `https://www.taptap.cn/app/54031/topic` 成功，标题正确渲染
- **登录态确认**：页面 cookie 中存在 `user_id`、`ACCOUNTS_USER_ID`、`XSRF-TOKEN` → 大哥的 Chrome 已登录 TapTap

### 6.4 全链路跑通证据
```
[采集] 第 1 页：10 条（total=20）
[采集] 第 2 页：10 条（total=30）
[采集] 第 3 页：10 条（total=40）
[采集] 第 4 页：10 条（total=50）
[采集] 本轮共 16 条帖子
[完成] 未命中QA 8 条，跳过（非提问）8 条
```
- `data/state.json`：16 条真实帖子记录
- `reports/questions.md` / `.csv`：报表正常生成，中文无乱码
- 识别逻辑验证："这个游戏还能玩吗？"→ no_match（提问但未命中 QA 库，正确）；"【前瞻】全新装扮登场…"→ skipped（非提问，正确）

### 6.5 taptap-cli 权限现状
- `taptap-cli auth status` 失败：`failed to save TapTap config C:\Users\Wa****XZ\.taptap-cli\taptap.json`（工作区外写入被沙盒拒）
- `auth login` 需大哥本人在浏览器完成 TapTap 账号授权，agent 无法代做
- 大哥确认：**当前无 app 54031 开发者权限**，正在申请 → 官方 `moment_intent`（问答求助/反馈建议）标签暂不可用

---

## 7. 按新规格重构（2026-10-26 12:48）

用户明确规格：每轮 1 次请求、间隔 10 分钟、只看最新 8 条、回答过/重复的忽略、命中 QA 点进去回复、四类标记。

### 7.1 四类标记体系
| 标记 | 值 | 触发 |
|---|---|---|
| ⏳ 未回复待回复 | `pending` | 分数 ≥ autoReplyScore(0.75) 且过冷却期 |
| ✅ 已回复 | `replied` | 发送成功 / 读评论发现我回过 |
| ➖ 无需回复 | `no_need` | 非提问 / 重复问题 / 早已回复 |
| 🖐 需人工处理 | `manual` | 未命中QA / 低置信 / 敏感词 / 发送失败 / 找不到输入框 |

### 7.2 请求量控制
- 稳态每轮 **1 次** `/feed/v7/by-group`（limit=10，按 commented_time 倒序取前 8）
- 仅当出现「首次见到的提问帖」才额外发 1 次 `moment-comment/v1/by-moment` 确认我是否回过（防重复回复）
- 典型轮次 1 次，最坏 9 次

### 7.3 代码结构（重构后）
```
src/watch.mjs        守护循环（interval 默认 600s）
src/collect.mjs      单轮：采集→判定→回复→报表（导出 runOnce 供 watch 调用）
src/reply.mjs        补发历史 pending
src/report-offline.mjs  离线重建报表
src/lib/classify.mjs 四类判定核心
src/lib/replier.mjs  opencli 浏览器回复执行器
src/lib/state.mjs    状态库 + 旧状态自动迁移
```

### 7.4 验证结果
- 语法检查：11 个 .mjs 全部 `node --check` 通过
- 旧 state（16 条，旧状态值 matched/suggest/no_match/skipped）自动迁移成功
  - `no_match` → `manual`（未命中 QA 库）8 条
  - `skipped` → `no_need`（非提问帖）8 条
- 报表四类分区渲染正确，CSV 带 BOM 中文正常
- `watch.mjs --once --dry-run` 在 WAF 拦截下正确降级，输出「本轮跳过，下轮再试」且进程不崩

### 7.5 WAF 封禁持续状态（重要）
- 首次被封：约 12:22
- 12:46 复测：**仍被拦**（`<meta name="aliyun_waf_aa">`），已持续 **>24 分钟**
- 结论：匿名接口封禁窗口较长，部署初期若接口封着属正常，守护进程空转等待即可，**不要反复重启刷请求**
- 已实现：识别 HTML 拦截页 → 退避 15s/30s/45s → 仍失败则跳过本轮

---

## 8. 排序参数真相（2026-10-26 14:26）★ 关键修正

之前用 `sort=default` 拿到的是推荐混合序，**不是时间序**，于是我错误地打算在客户端排序。用户指出「按发布时间排序是接口的功能，不能自己排」，遂重新逆向。

### 8.1 界面证据
官方论坛页排序菜单三项：`默认排序` / `回复时间` / `发布时间`（截图确认「发布时间」为选中态）。
→ 说明**接口支持**按发布时间排序，只是参数没找对。

### 8.2 参数不在接口返回里
`/feed/v7/by-group` 的 `data` 只有 `list / total / next_page` 三个字段，**不含排序选项**。
→ 排序参数是前端硬编码的，只能从前端 chunk 逆。

### 8.3 逆向过程
1. 抓取 `https://assets.tapimg.com/apps/web-app-next/_nuxt/` 下 66 个 chunk（静态资源）
2. `grep by-group` → 命中 `webapiv2.BBQjoOMe.js`（API 定义层）
3. 在 `AppForum.CqmJD41c.js`（论坛列表组件）中定位到请求参数构造：
   ``js
   sort: S(n.value, "params.sort", .value[0].params.sort)
   ``
   → 排序值来自**路由 query 的 `sort` 参数**并透传给 API
4. 同一文件出现路由守卫 `t==="commented"` / `t==="created"` / `t==="default"`

### 8.4 实测结论
| sort | 结果 |
|---|---|
| `created` | **按发布时间严格降序**（publish_time 1792995053→1792974111 完全有序） |
| `commented` | 按回复时间 |
| `default` | 推荐混合序，publish_time 明显乱序 |
| `created_at` / `rank` / `hot` | 报 `Field validation for 'sort' failed` |

`sort=created` + `limit=8` 一次请求 → 8 条严格按发布时间降序（1792995053→1792977641），`total=10000`（论坛体量很大）。

### 8.5 结论
**「取最新 8 条」的正确做法 = 接口参数 `sort=created` + `limit=8`，脚本只截断不排序。**
`fetch-latest.mjs` 已按此实现，并内置降序自检（顺序异常会告警但不自行重排）。

## 9. Skill 封装（2026-10-26 14:26）

已安装 `C:\Users\Wa****XZ\.dsh\skills\taptap-forum-moderator\`（20 个文件），并初始化数据目录
`C:\Users\Wa****XZ\.dsh\taptap-moderator\{qa,data,reports}`（QA 库已放模板）。

- 13 个 .mjs 全部 `node --check` 通过
- `fetch-latest.mjs` 实跑通过（输出 8 条真实帖子，按发布时间降序）
- 工作区留档：`output/`（方案、调研、报表、代码副本）；`work/skill/` 为安装前的构建副本

---

## 10. TapTap 表情支持（2026-10-26 16:01）★ 已打通并真发验证

### 10.1 结论
**回复可以包含 TapTap 自带表情**，但**不能用文字输入的方式**，必须模拟用户点选。

### 10.2 三条不可行的路（实测）
| 尝试 | 结果 |
|---|---|
| 直接输入 `[表情_开心]` | 编辑器不认，存成纯文本 `<p>测试表情 [表情_疑惑] 结束</p>` |
| `ClipboardEvent paste` 注入 HTML | ProseMirror 忽略，内容为空 |
| `type` 追加文字 | 对 contenteditable 是**整体替换**，把前面的全冲掉 |

### 10.3 可行的做法（三段组合）
1. `fill` 一次性填入完整纯文字（表情标记剥掉）
2. `eval` 把光标定位到目标字符位置（**只改 selection，不改内容**）
3. 点工具栏**第 2 个**按钮（表情）→ 面板里点具体表情 → 插到光标处

多个表情**从后往前**插，避免位置偏移。

### 10.4 关键 DOM 结构
编辑器（tiptap/ProseMirror）里的表情节点：
``html
<span data-type="tapEmoji" data-emoji-id="71" data-identifier="[表情_开心]"
      data-url="https://img-tc.tapimg.com/market/images/48516f62....png"
      data-style="inline" class="tap-emoji" contenteditable="false">
  <img src="..." alt="[表情_开心]" class="tap-emoji-img" contenteditable="false" draggable="false">
</span>
``
面板里的表情项：
``html
<img data-tap-editor-emoji="" data-tap-editor-emoji-id="71"
     data-tap-editor-emoji-url="https://img-tc.tapimg.com/.../48516f62....png"
     src="..." alt="开心" class="tap-editor-emoji-lists__tab-content-tab-img ...">
``
**注意属性名是 `data-tap-editor-emoji-id`**（不是 `data-emoji-id`，查错会找不到）。

服务端落库（实测）：
``json
{"type":"tap_emoji","children":[{"text":"[表情_开心]"}],"info":{"id":71,"img":{...},"style":"inline"}}
``

### 10.5 真发验证（两次，均成功）
- 第一次（手动）：「这波小游戏关卡确实有点多，慢慢来就好啦」+ `[表情_开心]` → 服务端确认落库
- 第二次（skill 正式链路 `collect.mjs --reply`）：文字 + **两个中间表情**（开心@第1****字后）
  - 日志：`表情：成功 2/2` → `[OK] 已发送 + 表情(吃瓜,开心)`
  - 服务端确认：`tap_emoji` 节点含 `[表情_开心]` 与 `[表情_吃瓜]`

### 10.6 踩过的坑（都已修）
1. **跨分组点选会插错表情** —— 想插"耶"实际插进"微笑"；且第一组的"耶"其实是
   `[TapTap×洛克王国世界_耶]`（id 517），不是 `[表情_耶]`（id 267）
   → 修：只用第 1 组，插入后校验 identifier，对不上就中止发送
2. **opencli `fill` 的 `verified` 对多行文本误报 false** —— 它把段落换行算进差异，
   实际内容完全正确（`<p>a</p><p><br></p><p>b</p>`）
   → 修：不用 verified，改为读 `innerText` 逐行比对关键片段
3. **面板按钮是 toggle** —— 盲点可能反而关掉面板，导致后续找不到表情
   → 修：加 `isPanelOpen` 先查状态再点
4. **opencli 的 `.ps1` wrapper 会拆开带引号的 JS 参数** → 改用
   `node <opencli>/dist/src/main.js` 直接调，参数走数组
5. **DSH 沙盒禁止 Node 派生进程**（`spawnSync ... EPERM`）→ 调试需 danger-full-access
6. **PowerShell 读改 UTF-8 中文文件会损坏**（GBK 误解码）→ 用 node/write 工具改，别用 shell 替换

### 10.7 表情清单
面板共 7 个分组、174 个去重表情；第 1 组「标准表情」61 个（id 70~130）最常用，
全表见 skill 的 `references/emojis.md`。

---

## 11. 改名与自包含改造（2026-10-26 16:46）

### 11.1 改名
- skill：`taptap-forum-moderator` → **`taptap-pvz2-forum-moderator`**
  （系统 skill catalog 已识别新名）
- 答疑库：`~/.dsh/taptap-moderator/qa/qa-library.md` → **`<skill>/qa/答疑库.md`**
- 旧数据目录 `~/.dsh/taptap-moderator/`（state/reports）已迁入 skill 内 `data/` `reports/`，随后删除

### 11.2 自包含化（为分享给其他成员）
- `scripts/lib/paths.mjs` 新增 `{{SKILL}}` 占位符解析（= skill 根目录）
- `scripts/config.json` 的 paths 全改为 `{{SKILL}}/...`：
  ``json
  "paths": {
    "dataDir": "{{SKILL}}/data",
    "qaFile": "{{SKILL}}/qa/答疑库.md",
    "stateFile": "{{SKILL}}/data/state.json",
    "reportsDir": "{{SKILL}}/reports"
  }
  ``
- 效果：**整个 skill 目录拷给同事，解压即用，不用改任何路径**

### 11.3 顺带增强
- QA 条目支持可选 `- 签名：xxx`，覆盖全局 `config.reply.signature`
  （优先级：QA 自带 > 全局 > 不加；见 `lib/classify.mjs` 的 `composeReply`）
- `SKILL.md` 增「分发给其他成员」章节与目录结构说明
- `references/ops.md` 增分发步骤、文件位置、排障表

### 11.4 验证
- 15 个 .mjs 语法检查全过
- 路径解析：`qaFile = C:\Users\Wa****XZ\.dsh\skills\taptap-pvz2-forum-moderator\qa\答疑库.md`
- 答疑库载入 6 条，字段完整（question/keywords/signature/answer）
- `watch.mjs --once --dry-run` 端到端跑通：待回复 0 / 已回复 1 / 无需回复 6 / 需人工 1
- 报表写入 `<skill>/reports/`，工作区留档与 skill 逐文件 hash 一致（代码 15/15、答疑库、报表、SKILL.md、references 4 篇全一致）
- 旧目录 `~/.dsh/skills/taptap-forum-moderator` 与 `~/.dsh/taptap-moderator` 已确认删除

---

## 12. 社区已答自动沉淀 + 答疑库生命周期（2026-10-26 17:29）

### 12.1 需求
用户：「有其他玩家已回复。自动总结，更新/添加 QA 问答数据库，并标记已回复。自动并标记总结此回答的时间。」
并追加：「优先使用多次更新、多次使用（引用）且时间较新的；超过 30 天未引用的归档到冷数据，整理间隔每月 1-5 号。」

### 12.2 实现：他人已答 → 自动总结入库
判定顺序新增第 2 条：`post.othersReplied`（且我未回）→ `replied / others_replied`。

总结策略（`lib/summarize.mjs`，纯启发式，无人值守可用）：
1. 展开回复树（含楼中楼）→ 按文本去重 → 滤掉噪音（顶/同问/哈哈哈/纯表情/长度<4）
2. 打分：答疑类徽章 +4、版主 +4、点赞 +、内容具体度 +2、含数字 +1、含问号 -1
3. 最高分为主答案，其余 score≥3 的作为「补充：」
4. 关键词：4 字不重叠块（精确）+ 2 字词（召回）+ 数字/英文词，共 ≤12 个

写入答疑库时带：`- 来源：<url>` `- 总结时间：<时间>` `- 摘自：<作者>（徽章）`
沉淀条目 `entry.auto = true` → 匹配分 ×0.9（低于人工条目）

### 12.3 实现：生命周期
`data/qa-usage.json`（不污染答疑库正文）：
```json
{ "items": { "<entryId>": { "cited": 0, "lastCitedAt": null, "createdAt": "...", "source": "...", "archived": false } },
  "lastArchiveAt": null }
```

匹配加权（`lib/qa.mjs`）：
```
最终分 = 基础分 × 权重
基础分 = 关键词命中率×0.6 + 文本相似×0.4（社区沉淀 ×0.9）
权重   = 1.0 + min(0.15, cited×0.03) + 0.05(7天内引用)/0.02(30天内) + 0.03(人工条目)
```

归档（`lib/archive.mjs`）：
- 触发：每月 1~5 号且本月未整理（`usage.lastArchiveAt` 记录）
- 规则：`lastCitedAt || createdAt` 距今 > 30 天 → 归档
- 去向：`qa/归档/答疑库-冷数据-YYYY-MM.md`，带 `<!-- 归档于…最后引用…累计引用… -->` 注释
- 主库重排，表头记录「上次整理 / 归档 N 条 / 保留 N 条」
- 只移动不删除

### 12.4 实测结果
**真实链路（帖子 863732444791046447「月球基地打完只给12个粗制抑能吗」）**：
```
评论数: 2
我回过: false  他人回过: true
自动总结:
  answer: "指正是碎片，错是给18个"
  fromAuthor: "123"  fromBadges: ["答疑智多星"]
  keywords: ["12","月球基地","打完只给","个粗制抑","月球","球基","基地","地打",...]
  summarizedAt: "2026-10-26 17:25:25"
入库结果: { added: true }
已标记: ✅ 已回复（他人已回复） + 已沉淀进答疑库
答疑库现在 7 条（社区沉淀 1 条）
```
**归档逻辑单测**：
- 40 天未引用 → 归档；3 天前引用 → 保留；从未引用且 35 天 → 归档 ✓
- 每月 1/3/5 号触发，6/15 号跳过，本月已整理后再判跳过 ✓
- 主库重排、冷数据文件带注释 ✓

### 12.5 本轮新踩的坑
1. **`来源` 正则误判**：`/来源[:：]/` 匹配到正文里的「钻石主要靠这几个稳定来源：」→ 把人工条目误判成社区沉淀（实测 6 条里 2 条误判）
   → 修：元数据只在 `---` 之前（meta 区）搜索；且来源必须是 `https?://` 开头
2. **`moment-comment/v1/by-moment` 的 limit 上限是 30**（50 报 `ByMomentRequest.limit failed`）
   → 已记入 `references/api.md`
3. **PowerShell `Set-Content` 会写 BOM** 导致 `node --check` 报 `Invalid or unexpected token`
   → 改用 node 写文件，或写后清 BOM

### 12.6 文件变化
新增：`lib/summarize.mjs`（自动总结）、`lib/usage.mjs`（引用统计+归档时机）、`lib/archive.mjs`（归档）、`scripts/verify-others.mjs`（单帖验证工具）
修改：`collect.mjs`（集成沉淀+引用+归档）、`classify.mjs`（他人已答分支）、`qa.mjs`（meta 区解析+加权）、`state.mjs`（OTHERS_REPLIED）、`report.mjs`（使用排行）、`config.json`（archive/usageFile/archiveDir）

---

## 13. 提问判定修复（2026-10-27 09:14）

### 13.1 用户反馈
> 「买了塔黄无尽用什么不较好」，意思是「买了塔黄无尽用什么比较好?」这个需要回复，原则是**尽量回答问题**。
（该帖此前被判为「➖ 无需回复 / 非提问帖」，属于漏判）

### 13.2 三个根因
1. **疑问词表缺「什么」** —— 早期只有「为什么」，没有单独的「什么」，所以「用**什么**不较好」匹配不到
2. **判定顺序错** —— 先判疑问词再判非提问标记，导致「【官方攻略】…困难6攻略」（正文含"怎么打"）被误判成提问（实测同批 6 篇攻略帖里 1 篇判错）
3. **误判不翻案** —— `no_need` 状态会无条件沿用，即使判定规则改了也不重新评估

### 13.3 修复
```js
// 判定顺序（先强信号后弱信号）
1. 明确非提问标记（【攻略】【前瞻】/兑换码/满勤/完成态…）→ 非提问
2. 明确疑问/求助词（补了「什么」「咋」「值得吗」等）→ 提问
3. 纯数字/纯字母数字 ID（2219833926）→ 非提问
4. 太短又无疑问词（<6 字）→ 非提问
5. 其余模糊 → **默认当提问**（原则：尽量回答）
```

翻案逻辑：
```js
// 只有新判定也是 no_need 才沿用；升级为 manual/pending 则采纳新判定
else if (prev.status === NO_NEED && verdict.status === NO_NEED) { 沿用 }
if (prev.status === NO_NEED && verdict.status !== NO_NEED) { log('[翻案] ...') }
```

### 13.4 验证（31 条用例全过）
| 用例 | 期望 | 结果 |
|---|---|---|
| 买了塔黄无尽用什么不较好 | 提问 | ✅ |
| 4353169611有人帮一下吗[表情_泪目] | 提问 | ✅（曾被 `[A-Z0-9]{8,}` 误伤） |
| 这关咋过啊 | 提问 | ✅（曾漏「咋」） |
| 【官方攻略】…困难6攻略 + 正文含"怎么打" | 非提问 | ✅（判定顺序修好后） |
| 2219833926 | 非提问 | ✅（纯数字） |
| 天宫码JF****o2 / 码 / 组队码，高活跃 | 非提问 | ✅ |
| 满勤，速来 / 终于打过了这个秘境 / 三个星期兑换了5阶阳光菇 | 非提问 | ✅ |

回归：原 22 条 + 新增 9 条边界 = **31/31 通过**

### 13.5 真实跑一轮效果
```
本轮 10 条：无需回复 5，需人工 5
  ➖ 组队码，高活跃            → 非提问 ✓
  🖐 剩下的换什么？🤔          → 需人工 ✓（是提问）
  🖐 4回合说唱金卡值不值得氪金   → 需人工 ✓
  ➖ 2219833926                → 非提问 ✓（修复后）
  🖐 只剩9没过了。              → 需人工（隐含求助，宽松判提问）
  🖐 为什么火龙果无尽会清场      → 需人工 ✓
  ➖ (无标题) / 天宫码JF****o2 / 码 → 非提问 ✓
```

## 14. 整理进 skill（2026-10-27 09:40）

上一轮只改了代码（`lib/qa.mjs` + `collect.mjs`），31 条回归用例和判定规则说明还留在工作区 `work/` 下 —— 等于**换个人接手就是黑盒**，改规则没有护栏。本轮补齐。

### 14.1 新增文件

| 文件 | 作用 |
|---|---|
| `scripts/test-question.mjs` | 提问判定回归测试，31 条用例，自带颜色输出，**失败退出码 1**（可挂 CI / 提交前自检） |
| `references/question-detect.md` | 判定规则完整文档：判定顺序图、NOT_ASK/ASK 词表、31 条用例表、3 个历史 bug 成因、改词表注意事项 |

用例是从 `work/test-question2.mjs`（22 条）+ `work/test-q3.mjs`（9 条）合并而来，路径改为相对 `./lib/qa.mjs`，跟着目录走，拷给别人直接能跑。

### 14.2 SKILL.md 增补

1. 新增 **「是不是提问（决定要不要回）」整节** —— 之前判定逻辑只藏在硬约束里，SKILL.md 正文没有可执行摘要。现在给出 5 步顺序 + 两个必须记住的点 + 跑测试的命令。
2. 脚本表新增 `scripts/test-question.mjs` 一行（可执行脚本）。
3. References 表新增 `references/question-detect.md`。
4. 硬约束 13 补「完整规则见 references/question-detect.md」；硬约束 14 补「改动判定规则必须附带回归用例，31 条全过才算改完；新发现的真实误判先补用例再改代码」。
5. **新增硬约束 15：`no_need` 状态不能无条件复用** —— 只有新判定也是 `no_need` 才沿用旧结论，升级则采纳新判定并打 `[翻案]`。这条原先只写在代码注释里，是「买了塔黄无尽用什么不较好」长期错判的直接原因，必须提到 SKILL.md 层。
6. 目录结构里 `references/` 的说明补「提问判定规则」。

### 14.3 顺带修掉的漂移

`scripts/verify-others.mjs` 在 build 源里带 UTF-8 BOM（2647 vs 2644 字节），以 skill 侧无 BOM 版本为准回填。`qa/答疑库.md` 以 skill 侧运行中的实库（7 条，含 1 条社区沉淀）为准回填 build 源。

> 注：本机 `pwsh` 实为 **PowerShell 5.1**，对无 BOM 的 UTF-8 文件用 `Get-Content` 读会按 ANSI 解码成乱码。刚才比对时出现的「verify-others.mjs DIFF」是读取假象，不是文件损坏 —— 中文文件一律用 `read` 工具比对，别用 `Get-Content`。

### 14.4 验证

```
$ cd ~/.dsh/skills/taptap-pvz2-forum-moderator && node scripts/test-question.mjs
✓ 31/31 全部通过

skill vs build 源（排除 data/ reports/ 归档/）：0 差异
output/ 留档：35 个文件，5 个关键文件 hash 全一致
```

### 14.5 同步结果

- 已安装：`C:\Users\Wa****XZ\.dsh\skills\taptap-pvz2-forum-moderator\`（SKILL.md 16966 字节）
- build 源：`work\skill\taptap-pvz2-forum-moderator\`
- 留档：`output\`（`src/test-question.mjs`、`references/question-detect.md`）

## 15. 夸答题玩家（楼中楼）功能 + 持续执行（2026-10-27 15:00~15:40）

用户需求：
1. 「执行 taptap-pvz2-forum-moderator，skill 我需要持续执行此内容」
2. 「如果遇到玩家答疑，请回复夸奖并带一个表情」
3. 「只关注处理 https://www.taptap.cn/app/54031/topic 此版」
4. 口径确认：「只有在表扬其他人有效回答才夸，其他均忽略」
5. 「不用输入 @」（夸奖文案不出现 @）

### 15.1 新增/改动文件

| 文件 | 作用 |
|---|---|
| `scripts/lib/praise.mjs`（新） | 挑夸奖对象 + 按语境挑 1 个表情 + 组装单行文案 |
| `scripts/lib/reply-nested.mjs`（新） | 楼中楼回复执行器（点回复→填文→插表情→发送→核验） |
| `scripts/test-praise.mjs`（新） | 夸奖逻辑回归测试（18 条断言） |
| `references/praise.md`（新） | 夸奖功能完整文档 + 10 条踩坑清单 |
| `scripts/lib/summarize.mjs` | 新增 `isUsefulAnswer`（沉淀与夸奖共用的门槛） |
| `scripts/lib/emoji.mjs` | 新增作用域版（`setCaretIn` / `readEmojisIn` 等） |
| `scripts/collect.mjs` | 新增 3b 阶段（夸奖发送）+ `praisedComments` 去重 |
| `scripts/config.json` | `myUserId=63****64`、`dryRun=false`、新增 `praise` 配置块 |
| `scripts/lib/qa.mjs` | 兑换码帖判定（多行 + 含字母长串） |

### 15.2 一个潜伏很久的 bug（最关键）

**评论数读错字段**：`collect.mjs` 读 `item.comment_count` —— 这个字段**根本不存在**，
真实位置是 `item.moment.stat.comments`。读出来永远是 0 →
「有评论才去读评论」的前置条件永不成立 → **社区沉淀和夸奖从来没触发过**。

修完后 `references/api.md` 的字段表也同步改了。

### 15.3 楼中楼机制（全部实测）

| 环节 | 结论 |
|---|---|
| 「回复」入口 | `.moment-post__tool-reply` 里的 **svg/path**（点外层 div 无效） |
| 是否已展开 | **条内有没有「发送」按钮**（空编辑器高度为 0，不能用高度判断） |
| toggle | 是 toggle，已展开时再点会关掉 |
| 表情面板 | `.tap-editor-emoji__popover`，**页面级 portal，不在评论项内** |
| 表情按钮 | 3 个工具栏 = @ 提及 / 表情 / 图片；表情按钮是唯一带 `.tap-popover__trigger-wrap` 的 |
| 打开面板 | 派发 mousedown→mouseup→click 到 `.tap-popover__trigger-wrap`（纯 `.click()` 无效） |
| 表情节点 | `<span data-type="tapEmoji" data-emoji-id=".." data-identifier="[表情_..]" class="tap-emoji">` |
| fill | **多行会清空**（含 `\n\n`）→ 夸奖文案必须单行 |
| 接口可见性 | `child_posts` **不返回被折叠的楼中楼** → 接口查不到 ≠ 没发出 |
| 校验 | 不能拿整条评论 innerText（含草稿）→ 假核验 |

### 15.4 关键转折：用户手动演示

卡在「表情面板打不开」时，用户说「你打开页面我看你能操作的那一步，然后我帮你继续，你监控」。
装了点击记录器（`document.addEventListener('click', ..., true)` + 轮询 `window.__oc_clicks`）后，
一次就抓到了用户的真实点击路径：

```
svg.tap-editor-toolbar-item__icon
  → SPAN.tap-popover__trigger-wrap
    → DIV.tap-popover
      → LABEL.tap-editor-toolbar-item__label
```

原来表情按钮是 trigger-wrap，触发点是 **mousedown**，而我一直在点 label。

### 15.5 误发与修正

调试过程中同一个回答被夸了 **3 次**（前两条带 `@`）：
- 原因 A：逐个试工具栏时点了 @ 按钮 → 文案里插入了 `@`（用户及时指出「不用输入 @」）
- 原因 B：接口不返回折叠回复 → 假阴性 → 以为没发出又发一次

修正：排除 @/图片按钮（按 SVG path 特征 + trigger-wrap 判定）、浏览器侧核验（展开折叠后搜文案）、
`state.posts[id].praisedComments` 记录已夸过的评论 ID。**用户明确表示重复的那两条不删（「错了就错了」）。**

### 15.6 真发验证

```
帖子 864096073424047526 → 楼中楼 403619469
  枫之谷_XZo: 泠只喵～ 说得又准又细，省了大家很多摸索 「版主助手-小鲸鱼」[表情_星星眼]

帖子 864120418414365903 → 楼中楼 403619915
  枫之谷_XZo: 谢谢 123 耐心解答，正是新手需要的那种答案 「版主助手-小鲸鱼」[表情_星星眼]
```

页面可见、表情为真实 TapTap 表情节点。

### 15.7 持续执行

- `config.reply.dryRun` 改为 `false`
- `myUserId` 填入 `63****64`
- 守护进程已起：`node scripts/watch.mjs`（每 600s 一轮，每轮 8 条，回复开启）

### 15.8 环境记录（踩坑）

- 本机 `pwsh` 实为 **PowerShell 5.1**：`Get-Content` 读无 BOM 的 UTF-8 中文会按 ANSI 解码成乱码，
  比对文件要用 `read` 工具；`Select-String` 会缓冲输出（后台任务里看不到实时日志）
- 沙盒下 node `spawnSync` 抓子进程 stdout 会 EPERM → 驱动 opencli 必须 `danger-full-access`
- `oc().text` = stdout+stderr，stderr 里有 opencli 升级提示 → `Number()` 得 NaN，必须用 `.out`

## 16. 回复的 4 条铁律（2026-10-27 16:00）

用户追加要求：

1. 「如果需要多次回复，请不要重复使用同一内容，或相似内容」
2. 「回答，只能回答 skill 内资料库内容，不能泄露其他内容」
3. 「可以自行搜索内容回答，自行组织话语」
4. 「不知道、不能回答的，可以委婉拒绝。或不理会」

### 16.1 实现

| 规则 | 实现 | 文件 |
|---|---|---|
| 不重样 | 6 种「说法外壳」× 4 种收尾句，共 12 种组合；已发文本记进 `state.recentReplies`（保留最近 200 条），选的时候优先挑没用过的 | `lib/variants.mjs` |
| 只答库内 + 不泄露 | 发送前过 `assertNoLeak()`：命中「答疑库/资料库/state.json/config.json/scripts//references//机器人/AI/opencli/WAF/webapiv2/api key/token/cookie」等 → **拒发并转人工**（新状态 `leak`） | `lib/variants.mjs` + `collect.mjs` |
| 可自己组织话 | 社区答案沉淀进库后，回帖用**自己的说法外壳**包同一份答案（不照抄原文）；外壳只做「引入方式」的改写，**不引入任何新事实** | `lib/classify.mjs` 的 `composeReply` |
| 不知道就不理会 / 婉拒 | 默认**不理会**（转「🖐 需人工」由版主处理）；`config.reply.refuseOnUnknown=true` 才发一句婉拒（3 选 1 + 表情） | `collect.mjs` 3c 阶段 |

### 16.2 设计取舍

- **外壳只改「怎么引入」，不改「说什么」** —— 避免为了「不重样」而编造事实（违反第 2 条）
- 变体选择用 `hash(帖子ID + 答案)` 做种子 → 同一帖子每次结果稳定，不会在重试时变化
- 12 种组合用尽后才 `duplicated=true`（上层可据此决定跳过而不是硬发）

### 16.3 测试

```
node scripts/test-question.mjs   → ✓ 35/35
node scripts/test-praise.mjs     → 18/18
node scripts/test-variants.mjs   → 23/23
```

`test-variants.mjs` 覆盖：答案原文完整保留、6 次回复各不相同、命中已用文本会换说法、
变体用尽会标记 duplicated、7 类泄露文本被拦、4 类正常文本放行、婉拒文案自带表情且不含内部信息。

### 16.4 运行状态

- 守护进程：`node scripts/watch.mjs`（600s/轮，回复开启），已用新代码重启
- installed skill 34 个文件，与 build 源 **0 差异**
- 留档 `output/` 41 个文件

## 17. 常驻方案 + 分享边界（2026-10-27 17:45）

### 17.1 关键结论：不能做成 Windows 服务

| | Windows 服务 | 计划任务（登录时运行） |
|---|---|---|
| 会话 | **Session 0**（无桌面） | 用户交互式会话 |
| 操作 Chrome | ❌ 做不到 | ✅ 可以 |

本工具回复全靠操作**已登录的真实 Chrome**，服务跑在 Session 0 看不到桌面浏览器。
→ 正解是**计划任务 + AtLogOn + 崩溃重启**，代价是机器必须保持登录（锁屏可以，注销/关机不行）。

### 17.2 新增部署资产

| 文件 | 作用 |
|---|---|
| `scripts/schedule.ps1` | `-Action install/doctor/status/start/stop/uninstall` |
| `scripts/run-watch.cmd` | 启动器：切目录 + 写 `logs\watch.log` + 5MB 轮转 + 记退出码 |
| `references/ops.md` | 重写：方案对比 / 安装步骤 / 无人值守 / 分发清单 / 多人边界 / 排障 |

安装时把 `node.exe` 绝对路径固化成 `scripts\node-path.txt`（计划任务环境变量可能不完整）；
任务用 `MultipleInstances IgnoreNew` 保证**绝不并发多开**。

### 17.3 本次踩的编码坑

- `schedule.ps1` 无 BOM 时，PowerShell 5.1 按 ANSI 解码 → 中文把字符串引号挤坏 → 解析报一堆语法错误。
  **`.ps1` 必须存成 UTF-8 with BOM**（`.mjs` 反而不要 BOM）。
- `run-watch.cmd` 里**不能有非 ASCII**（cmd 对 UTF-8/BOM 处理很糟）→ 注释全改英文。

### 17.4 进程检测误报

用 `-like '*watch.mjs*'` 查进程会把**查询命令自身**和 DSH 的 `runner.js` 包装进程也算进去，
一度以为有两个守护在跑。改成 `-match 'watch\.mjs"?\s*$'` + 排除 `runner.js` 后正常。

### 17.5 分享给其他人的边界（重要）

| 事实 | 后果 |
|---|---|
| `data/state.json` 每人独立 | A 回过哪些帖 B 不知道 → **同一问题会被多人各回一遍** |
| `myUserId` 各不相同 | 互相判定不出「我已回过」 |
| 答疑库各改一份 | 答案口径不一致 |

结论：**能分享，但只能有一个账号开自动回复**。其他人：
- `node scripts\watch.mjs --no-reply` 只采集出报表，不发言；或
- 直接看主号的 `reports\questions.md`

代码层没有跨机锁，多人同时回只能靠**人工排班**。

### 17.6 守护运行观察（15:56~17:41，12 轮）

- 沉淀 4 条新问答（回忆之旅乱码 / 猴子装扮不显示已拥有 / 祝福没作用吗 / 被做局了）
- 夸奖 3 位玩家，表情按语境分别选了 `开心` / `点赞` / `比心`（说明自动挑表情是有效的）
- **@ 按钮一次都没被点**，表情全部校验通过
- ⚠️ 12 轮里 **`待回复` 始终为 0** —— 没有一条命中答疑库 ≥0.75，说明答疑库覆盖面/关键词还不够

## 18. 用户补充的三条问答 + 分享帖轻互动（2026-10-27 18:00 ~ 2026-10-28 09:20）

### 18.1 用户亲手答了 3 条 → 自动抓取补充答疑库

| 帖子 | 版主（枫之谷_XZo）的回答 | 入库关键词（口语化） |
|---|---|---|
| 剩下的换什么？🤔 | 「我会拿背景，其他的基本会返场。」 | **十月同游**、同游兑换、剩下的换什么、背景、返场、脚链、花环、水母帽… |
| 4回合说唱金卡值不值得氪金 | 「不值得，不差这点。没有也能玩，除非你是氪佬重氪」 | **双人对决**、说唱金卡、值不值得氪金、4回合、霹雳舞、速攻、重氪… |
| 只剩9没过了。 | 「剩下的不好过，要不等，要不只能花蓝色石头过了~~」 | —— **用户澄清：这是「普通关卡」的分享，不是提问** |

前两条按用户补充的上下文（十月同游 / 双人对决）改了问法和关键词；第三条**从库里删掉**，
并在 `qa.mjs` 加了「弱非提问」档（`WEAK_NOT_ASK`：只剩…没/还差/就差/没打完…），
注意它必须排在 ASK 之后 —— 「只剩9没过，怎么打」仍是提问。

### 18.2 命中率为 0 的真正原因：打分公式有缺陷

诊断（`work/diag-hits.mjs`）显示分数**两极分布**：0.9（自己匹配自己的沉淀条目）或 ≤0.14，
所以**阈值从 0.75 降到 0.45 命中数一条不变**。真问题在公式：

```js
旧：kwScore = 命中数 / 关键词总数     ← 关键词写得越多，分数被稀释得越厉害
新：kwScore = min(1, Σ命中词 min(1,字数/4) / 2)   ← 饱和 + 长度加权
旧：相似度 = dice(post, 问法 + 关键词拼一起)      ← 词越多相似度越低
新：相似度 = dice(post, 问法)                     ← 只跟问法比
```

实测：**一条 18 词的新条目连自己的原题都只有 0.19**（旧公式）→ 改完 0.774。
阈值按实测分离度定为 **0.65**（正例 ≥0.77、负例 ≤0.19）。

### 18.3 新增 `scripts/test-match.mjs`（18 条断言）

锁住「该命中的命中、不该命中的不命中」，防止以后改公式改出回归。

### 18.4 分享帖轻互动（用户：「分享的也可以进去说说话」）

- `looksLikeShare()`：分享/记录/进度/只剩…没/终于/打过了… → **排除**兑换码/组队/满勤/招募/出售/攻略
- `buildShareText()`：6 套鼓励语 × 4 个表情，避开已用文案，**只说话不输出信息**
- 单独一档（3d 阶段），单轮上限 2，同一帖只互动一次（`state.posts[id].shareCommented`）

### 18.5 ⚠️ 事故：用构建源覆盖了运行中的答疑库

同步时把**构建源的 14 条旧副本**覆盖到运行中的库（实际已沉淀 24 条）→ **一夜的 10 条全丢**。

恢复过程：
1. `data/qa-usage.json` 保留了每条沉淀条目的**来源链接** → 有据可查
2. 写 `rebuild-qa.mjs`：按来源链接重新抓社区回答，用同样的 `buildQaEntry` 重建
   （手工精修的两条按来源排除，避免被自动重建覆盖）
3. 恢复结果：**25 条**（8 人工/精修 + 17 重建），内容与原版一致或更好

根治措施：
1. **同步方向写进文档**：答疑库只能「运行中 → 构建源/留档」，不能反着来（SKILL.md 硬约束 31、ops.md 第 6 节）
2. **每轮自动备份** `qa/答疑库.md.backup.md` + `scripts/restore-qa.mjs --restore` 一条命令回退

### 18.6 整夜运行观察（18:21 ~ 次日 09:07，约 90 轮）

- 答疑库从 14 条长到 **24 条**（一夜自动沉淀 10 条）
- 夸奖 **9 次**全部成功（表情按语境自动挑选：点赞/星星眼/开心），页面核验全过
- 零报错、零重复回复、零 WAF 拦截
- ⚠️ `待回复` 仍为 0 —— 因为库里唯一能高分命中的就是「自己沉淀的那条」，这是设计使然；
  库的价值在于**以后遇到同类问法**能答（命中率会随库增长上升，见 `reports/gaps.md`）

## 19. 脚本收拢（2026-10-28 09:40~10:10）

用户指出：「每次都在写新脚本…查看、等可以复用脚本整理到 skill 并添加引用说明」。

### 19.1 问题

`work/` 下堆了 **53 个一次性 .mjs**，且：
- 硬编码 `C:\Users\Wa****XZ\.dsh\...` 路径 → **拷给别人直接不能用**
- 同一能力多份副本（append/rebuild/mark-replied… 各有实现）→ 各自漂移
- 依赖本地 fixture（`work/cmt1.json`）→ 不可移植

### 19.2 收拢结果

| 新 CLI | 覆盖了原来哪些脚本 |
|---|---|
| `scripts/qa-admin.mjs` | append-qa / update-keywords / register-usage / rebuild-qa（→ `show/append/keywords/register/rebuild/backup`） |
| `scripts/post-admin.mjs` | fetch-answers / mark-replied / reset-praised / cleanup / diag-hits（→ `fetch/mark-replied/reset-praised/reset-share/cleanup/diag`） |
| `scripts/probe-dom.mjs` | probe2~6 / probe-nested / probe-multi-editor / probe-popover-owner / probe-find-praise / dbg-nested2~9 / monitor / monitor2 / inspect-now / step-for-user / oc-eval（→ `comment/editor/emoji/watch/eval`） |
| `scripts/test-summarize.mjs`（新） | test-summarize（去掉本地 fixture，改自造数据 + 断言） |
| `scripts/test-archive.mjs`（新） | test-archive（改成断言式 + 用 `os.tmpdir()`，不再硬编码路径） |
| `references/admin.md`（新） | 两个 CLI + 探针的用法、典型流程、硬约束 |

**全部改成读 `scripts/config.json` 的路径**，拷给别人照样能用。
`work/` 里 54 个一次性脚本 + `js/` 目录**全部删除**（能力已被覆盖，避免多份副本漂移）。

### 19.3 探针里最值钱的一个

`probe-dom.mjs watch` —— 记录你**手动点击的元素路径** + 面板状态变化。
当初「表情面板打不开」卡了很久，就是靠它抓到真实触发点是
`svg.tap-editor-toolbar-item__icon → span.tap-popover__trigger-wrap`（而不是 label）。

### 19.4 验证

```
test-question 36/36   test-praise 18/18   test-variants 40/40
test-match    18/18   test-summarize 21/21  test-archive 17/17
```

skill 51 个文件，留档 53 个文件。

## 20. 旧帖错判 + recheck 工具（2026-10-28 10:00）

用户发现 `reports/questions.csv` 里这一行有问题：

```
| [未来礼盒什么时候返场](https://www.taptap.cn/moment/863747312214608939) | 果果 | 2026-10-26 11:43 | 0 | 非提问帖 |
```

「未来礼盒什么时候返场」明显是提问帖，而且已有玩家回答。

### 20.1 根因：错判永远无法翻案

- 这首帖是 **10-26** 判的，当时词表缺「什么 / 返场」→ 判成非提问
- 规则早就修好了，但**「翻案」只在扫描窗口（最新 8 条）内生效**
- 老帖早已滑出窗口 → 状态里的错判**永远不会被重新评估**，报表就一直错着

### 20.2 新增 `post-admin.mjs recheck`

```
recheck <momentId...> [--praise]   逐条：抓评论 → 当前规则重判 → 翻案 → 沉淀 → （可选）夸奖
recheck --all [N] [--apply]        批量：只看标题预演，--apply 才写状态
```

**这条帖的实测结果**：

```
《未来礼盒什么时候返场》
  原判定：no_need/not_question
  新判定：replied/others_replied   ← 有变化
  [沉淀] 《未来礼盒什么时候返场》 ← 摘自 依星&寻梦
  [夸奖] 依星&寻梦（评论 403554010，表情 开心）
```

论坛上已核验：`依星&寻梦 说得又准又细，省了大家很多摸索 「版主助手-小鲸鱼」[表情_开心]`

### 20.3 批量扫出的历史错判（82 个历史帖）

```
9 条判定有变化：
  【官方攻略】…困难1-12攻略   manual/no_qa_match → no_need/not_question
  【官方攻略】…困难6攻略      manual/no_qa_match → no_need/not_question
  为什么火龙果无尽会清场      manual/no_qa_match → manual/low_confidence
  十月同游7427456531        manual/no_qa_match → manual/low_confidence
  十月同游                  manual/no_qa_match → no_need/not_question
  十月同游3335212516        manual/no_qa_match → manual/low_confidence
  抽满 / 魔术菇 / 天宫码      manual/no_qa_match → no_need/not_question
```

**双向都能抓**：漏判的提问帖（no_need → manual）和误判成提问的攻略帖（manual → no_need）。

### 20.4 批量模式的教训：只看标题不够

第一版 `--all` 直接写状态，结果「天宫码」被刷成 no_need，**下一轮就被守护进程按正文翻回 manual**
（正文里有「有没有人互换」这类疑问词，标题看不出来）。

改成：**默认只预演**，加 `--apply` 才写；文档明确「准确做法是逐条 `recheck <id>`」。

### 20.5 顺带重构

夸奖发送逻辑从 `collect.mjs` 抽到 `lib/praise-send.mjs`，
`collect` 的 3b 阶段与 `post-admin recheck --praise` **共用一份实现**，避免两条路径行为漂移。

### 20.6 验证

```
test-question 38/38（新增 2 条：未来礼盒什么时候返场 / 这个活动什么时候结束）
test-praise 18/18  test-variants 40/40  test-match 18/18
test-summarize 21/21  test-archive 17/17
构建源 / 已安装 / 留档 三方一致性：0 差异    答疑库 27 条
```

## 21. 文案口吻：口语化 / 亲切 / 多样（2026-10-28 10:40）

用户要求：「夸奖、回答，说话的时候人性化，**保持**口语化、亲切、多样」（原打字为「保存」，
随即订正为「保持」—— 是持续性约束，不是一次性改动）。并给了 4 条标杆：

```
1. 哇~XX大佬，牛逼[表情]
2. a、大佬，好肝啊！[表情]   b、大佬，肝肝还好吗？
3. XX植物没用，但是可以当花瓶[表情]
4. 正常，玩到正版了，拓维正常操作。
```

### 21.1 问题：第一版是客服腔

对照标杆，改前的夸奖文案是：

```
❌ 感谢 {name} 的热心解答，讲得很清楚，帮到不少人[表情]
❌ {name} 这个回答很到位，我这边也学习了[表情]
```

事实没错、语气全错 —— 这是**回访客服**的口吻，不是玩家在评论区打字。
回答外壳同理：`关于这个问题：…` / `一句话概括：…` 是工作汇报腔。

### 21.2 改了什么

| 场景 | 改前 | 改后 |
|---|---|---|
| 夸奖 | 4 套客服腔模板 | **12 套口语模板**，分惊叹型 / 亲切感谢型 / 服气点赞型 |
| 答题开头 | 补充一下：/ 关于这个问题：/ 一句话概括： | 说白了，/ 简单说，/ 直接说结论：/ 给你捋一下：/ 按我自己的经验， |
| 答题收尾 | 希望有帮助～ / 祝你早日通关！ | 差不多就这些，试试看～ / 先按这个来，慢慢就顺了 / 还有不懂的直接问就行～ |
| 分享互动 | 6 套通用鼓励 | **按情绪分桶**：晒进度→夸（大佬，好肝啊 / 肝肝还好吗 / 我酸了）；吐槽翻车→共鸣（正常，玩到正版了 / 拓维正常操作） |
| 婉拒 | 这个我也不太确定，怕说错误导你… | 这块我还没摸透，先别听我瞎猜，等个准话更好 |

散列种子从「昵称」改成「**昵称 + 答案开头**」：同一条回答永远同一句（不会重试时跳变），
同一个人答不同问题时换说法（不会每次都被同一句招呼）。

### 21.3 修掉的两个隐藏 bug（都是试运行才暴露）

**bug 1：收尾句永远轮不到。**
候选列表原先每个开头都是「无收尾」排在「带收尾」前面 → 第一个没用过的永远是「无收尾」。
试跑 5 条答案，收尾句**一次都没出现**。改成一半先给带收尾的版本。

**bug 2：加了收尾句后，表情跑到句子中间。**
答疑库不少答案是表情结尾的（「…慢慢来就好啦[表情_开心]」），
直接追加收尾句就变成「…就好啦[表情_开心]\n\n差不多就这些」—— 像被截断。
改成先把末尾表情摘出来（`splitTailEmoji`），拼好收尾句再放回句尾：
「…就好啦\n\n差不多就这些，试试看～[表情_开心]」。
（表情位置由 `parseEmojiSegments` 在最终字符串上重算，挪动安全。）

### 21.4 分享互动加了情绪分桶，同时收紧边界

`looksLikeShare` 原先只认「分享/记录/进度」→ 吐槽帖（「又闪退了」）根本不会去说话。
现在也认**纯情绪吐槽**（崩了/闪退/离谱/笑死/无语/麻了/正常操作…）→ 走共鸣桶。

但**明确排除涉维权/损失的帖子**：含 `退款|客服|补偿|封号|举报|充值|消费|损失|维权|申诉|投诉`
→ 不互动，留给版主判断。理由：在这种帖子下说「正常操作」是火上浇油，
而且这类帖子本来就已经被 `config.reply.blacklistWords` 挡成「需人工」。

### 21.5 口吻护栏（写进测试，防止以后改回去）

`test-praise.mjs` 新增一组断言：

```
✓ 没有客服腔（正则拦 感谢…热心解答 / 讲得很清楚 / 帮到不少人 / 尊敬的 / 请知悉 …）
✓ 每条模板都有口语特征（大佬|哇|服|牛|稳|好家伙|顶|靠谱）
✓ 每条都点名（楼中楼不点名不知道夸谁）
✓ 每条够短（减掉昵称 ≤20 字）
✓ 30 个玩家 → 至少 10 种说法
✓ 同一人同一条回答措辞稳定 / 同一个人不同回答会换说法 / 避开已发过的
✓ 单行 / 恰好 1 个表情 / 表情在结尾 / 表情都在标准组内
```

`test-variants.mjs` 同步加了：「24 种说法里没有公文腔」「分享帖情绪分桶」「吐槽桶不带事实判断」
「20 条分享互动至少 5 种说法」。

### 21.6 验证

```
test-question 38/38   test-praise 31/31   test-variants 51/51
test-match    18/18   test-summarize 21/21  test-archive 17/17
构建源 / 已安装 / 留档 三方一致性：0 差异（9 个改动文件逐个 SHA256 比对）
```

实际生成的文案（试跑预览）：

```
夸奖：
  好家伙，依星&寻梦大佬这也懂 「版主助手-小鲸鱼」[表情_星星眼]
  有123大佬在，新手有救了 「版主助手-小鲸鱼」[表情_点赞]
  哇~沉默的羔羊大佬，牛逼 「版主助手-小鲸鱼」[表情_比心]
分享·晒进度：大佬，好肝啊[表情_点赞] / 这进度，我酸了[表情_星星眼]
分享·吐槽：  正常，玩到正版了[表情_狗头] / 拓维正常操作[表情_汗]
回答外壳：    给你捋一下：…（答案原文不动）… 有更好的打法也欢迎补充～[表情_开心]
```

### 21.7 不变的三条底线

口吻再随意也不碰：**事实只来自答疑库**（外壳只换语气，答案正文一字不改）、
**过泄露自检**、**格式硬约束**（夸奖单行、表情在结尾、只用标准表情组）。

> 口吻这件事没有「完成」状态 —— 用户明确说「**保持**」。
> 以后任何新增文案（新模板、新 CLOSER、新 REFUSAL）都要过 21.5 那组护栏。

## 22. 按用户反馈再收一轮（2026-10-28 12:10）

用户第二次反馈（三条）：

```
1. 排查一下，QA 回答的还是正式说明。
2. 其他分享等按照玩家口气。
3. 还有要多样：玩家是可以看到所有回复的。不要模板化、或者说模板至少 15 套以上。
```

### 22.1 排查结论一：模板化是真的，主页一翻就看出来

把 `data/state.json` 的 `recentReplies` 拉出来看，16 条历史文本里：

```
「…说得又准又细，省了大家很多摸索」  → 4 次
「感谢 … 的热心解答，讲得很清楚…」  → 3 次
「看着就爽，加油」「厉害，我追都追不上」 → 各若干次
```

用户说的「玩家是可以看到所有回复的」是准确的 —— 4 套模板 + 固定表情，**
主页上就是一条规律**。这比「单条文案不够亲切」严重：单条只是不够好，重复是可识别的机器痕迹。

### 22.2 排查结论二：答疑库里一半是垃圾（沉淀把我的夸奖当答案）

27 条里：

| 类型 | 条数 | 例子 |
|---|---|---|
| 答案 = 我自己的夸奖句 | 3 | 「回忆之旅乱码」→「依星&寻梦 说得又准又细…」 |
| 答案 = 真实答案 + 我的夸奖 | 2 | 「私人拖尾」→「…补充：谢谢 123 耐心解答…」 |
| 答非所问 / 不是答案 | 4 | 「大佬们接下来搞什么植物」→「大哥的超装不错，可惜没钱」 |

根因：`buildQaEntry` **没有排除我自己的评论**，而 `scoreReply` 给版主 +4、给答疑徽章 +4
—— 我自己就是版主，所以我盖的夸奖楼永远得分最高 → 必被判成「最佳答案」。

这些条目一旦命中，就会**把夸奖句当答案发出去**。这是比语气更严重的问题。

### 22.3 排查结论三：答案正文是说明文体

保留下来的条目里，人工/版主写的那几条是标准的说明书句式：

```
「钻石主要靠这几个稳定来源：1. 每天签到 + 每日任务的固定产出；2. 植物探险、碎片挑战每天打完…」
「先分清是**配置问题**还是**阶数问题**：- 阶数不够 → 去刷碎片升主力植物阶数…」
```

外壳（开头/收尾）换得再多，主体还是说明书 → 用户看到的仍然是「正式说明」。

### 22.4 改了什么

**① 修沉淀 bug**（`lib/summarize.mjs`）

```js
buildQaEntry({ post, comments, myUserId, signature })
  → 排除 authorId === myUserId 的评论
  → 排除任何含「版主助手 / 小鲸鱼」字样的评论（签名兜底）
```

4 个调用点全部传参：`collect` / `post-admin` / `qa-admin rebuild` / `verify-others`。

**② 重写答疑库正文为玩家口气**（事实一字不改）

| 改前 | 改后 |
|---|---|
| 钻石主要靠这几个稳定来源：1. 每天签到 + 每日任务的固定产出… | 钻石主力就靠这几样：每天签到和每日任务先领满；植物探险、碎片挑战每天清掉…攒起来不算慢。 |
| 如果是长期玩，免广告这类一次性投入性价比最高。 | 打算长期玩的话，免广告那种一次性投入最划算。…别冲动了。 |
| 优先拿背景（背景一般不会返场），其他基本都会返场，不急着一次换完。 | 优先换背景，背景一般不会返场；别的多数都会返场，不用急着一次换完。 |

19 条保留并改写（含守护进程新沉淀的「地宫秘境」），
**9 条坏条目没有删除**，移到 `qa/归档/答疑库-坏条目-20261028.md`，逐条写明剔除原因（A 类 5 条 / B 类 4 条）。
改动前留了 `qa/答疑库.md.before-20261028` 备份。

**③ 模板池全部扩到 ≥15 套**

| 池子 | 改前 | 改后 |
|---|---|---|
| `PRAISE_TEMPLATES` | 12 | **18**（惊叹 5 / 亲切 6 / 服气 5 / 轻调侃 2） |
| `OPENERS` | 6 | **16** |
| `CLOSERS` | 4 | **16** |
| `SHARE_PROGRESS` | 7 | **16** |
| `SHARE_TEASE` | 4 | **16** |
| `REFUSALS` | 4 | **8** |

**④ 加「近期口气避重」**（不只是避开一字不差）

- 夸奖：把模板拆成固定片段，拿片段去比 `usedTexts`，命中就把这几种口气整体挪到队尾
- 回答：最近用过的 `opener.tag` / `closer.text` 整体挪到队尾
- 分享：同上，按正文比对

效果（测试断言）：**连夸 8 个人 → 8 种不同口气；连回 10 条 → 10 种不同开头、收尾也不重样**。

**⑤ 测试加下限护栏**

```
test-praise    34 条：模板池 ≥15、模板无重复、连夸 8 人 8 种口气
test-variants  60 条：openers/closers/shareProgress/shareTease/refusals 五项池子下限、
                     连回 10 条开头不重样、收尾不重样、全文互不相同
test-summarize 27 条：+6 条「不能把我自己的评论沉淀成答案」（含「没传 myUserId 也能靠签名挡掉」）
```

### 22.5 实机验证

守护进程重启后第一轮就发出了新模板的夸奖（说明新代码真的在跑）：

```
[沉淀] 《又是没出萝卜的一天》 ← 摘自 123
[夸奖] 123（帖：又是没出萝卜的一天）
[OK] 已夸奖（表情 星星眼）（页面已核验到）

实际落库文本：
  这才是老玩家，123大佬 「版主助手-小鲸鱼」[表情_星星眼]
```

对比改前的历史文本（`感谢 花誕 的热心解答，讲得很清楚，帮到不少人`）—— 口气已经换掉。

答疑库自检：

```
条目数 20
含「小鲸鱼」签名的条目：0     ← 沉淀 bug 已不再产生脏数据
```

### 22.6 验证汇总

```
test-question 38/38   test-praise 34/34   test-variants 60/60
test-match    18/18   test-summarize 27/27  test-archive 17/17
构建源 / 已安装 / 留档：13 个文件逐个 SHA256 → 0 差异
答疑库 20 条，三方一致
```

### 22.7 一条元教训

用户两次提「人性化」，第一次我只改了**外壳**（夸奖文案 + 开头收尾），漏了**主体**（答疑库正文）。
外壳占比不到 30% 的字数，主体还是说明书 → 用户一眼就看出「还是正式说明」。

**判断改得够不够，标准不是「代码里改了几处」，而是「玩家实际看到的整段文字像不像人话」。**
下次改文案，先把一条真实回复从头到尾读一遍，再决定改哪里。

## 23. 答疑库剔除「携带自己标签」的条目（2026-10-28 12:40）

用户要求：**「答疑库，剔除携带自己标签（当前是「版主助手-小鲸鱼」）的夸奖、回答。」**

### 23.1 先核对现状：存量已经是 0

上一轮修沉淀 bug 之后，三份答疑库（构建源 / 已安装 / 留档）都是 20 条、『小鲸鱼 | 版主助手』命中 **0**。
所以这次不是「再清一遍」，而是**把这条规则固化成能反复执行的入口** ——
这类问题已经发作过一次（5 条脏数据），不能只靠「代码改好了」这一句话。

### 23.2 新增 `qa-admin.mjs purge-tag`

```
node scripts/qa-admin.mjs purge-tag              # 只体检，不写文件
node scripts/qa-admin.mjs purge-tag --apply      # 真剔除（移到 qa/归档/）
node scripts/qa-admin.mjs purge-tag --tag 小鲸鱼   # 自定义标签
```

设计要点：

| 点 | 做法 | 理由 |
|---|---|---|
| 判定范围 | 只看每块 `---` **之后**的正文 | 元数据里的「摘自」不算；避免误伤 |
| 标签来源 | `config.reply.signature` + 去书名号内文 + `版主助手` + `小鲸鱼` | 签名将来改了也不用改代码 |
| 默认模式 | **只体检** | 和学习 `recheck --all` 的教训一致：默认不写状态 |
| 剔除方式 | **移动**到 `qa/归档/答疑库-剔除自己标签-<日期>.md` | 沿用「只移动不删除」策略，可回退 |
| 落盘前 | 先备份 `qa/答疑库.md.before-purge-<日期>` | 出事一键拷回 |

### 23.3 实测（在构建源里造脏数据跑全流程）

故意追加 2 条带签名的假条目（一条纯夸奖、一条真实答案 + 我的「补充：」），然后：

```
体检：
  发现 2 条携带自己标签的条目：
    ✗ 《测试用的脏条目A》  命中「「版主助手-小鲸鱼」」
    ✗ 《测试用的脏条目B》  命中「「版主助手-小鲸鱼」」
  （预览模式，没有改动任何文件…）

--apply：
  已剔除 2 条 → 归档到 qa/归档/答疑库-剔除自己标签-20261028.md
  主库：22 → 20 条
  （改动前的库留在 qa/答疑库.md.before-purge-20261028）

复检：
  答疑库干净：20 条，没有携带自己标签的条目
```

测试痕迹已清理（构建源恢复成运行中的 20 条，测试用归档文件删除）。

### 23.4 三层防护

| 层 | 位置 | 作用 |
|---|---|---|
| 生成端（硬挡） | `buildQaEntry({ myUserId, signature })` | 自己的评论 + 含标签的评论**根本不进库** |
| 存量端（工具） | `qa-admin.mjs purge-tag` | 随时体检，一键剔除并归档 |
| 规则端（文档） | SKILL.md 硬约束 33 + `references/admin.md` | 写清楚为什么、怎么做、怎么回退 |

### 23.5 验证

```
已安装目录 purge-tag：干净（20 条，0 命中）
test-question 38/38  test-praise 34/34  test-variants 60/60
test-match    18/18  test-summarize 27/27  test-archive 17/17
构建源 / 已安装 / 留档：SKILL.md、admin.md、答疑库、qa-admin.mjs 逐个 SHA256 → 0 差异
```

### 23.6 归档目录现状

```
qa/归档/答疑库-坏条目-20261028.md        4658 B   （上一轮剔除的 9 条，含原因说明）
qa/归档/答疑库-剔除自己标签-<日期>.md      按需生成（本工具产出）
```

两个归档文件都**不是**答疑库的一部分，`loadQaLibrary` 只读 `qa/答疑库.md`，不会命中它们。

## 24. 体检改成每天自动跑（2026-10-28 13:05）

用户追加两条要求：

```
1. 可以体检，但是我不希望频率太高。每天就行。如果需要，可以主动申请（请给出明确选项）
2. 体检希望自动跑。
```

### 24.1 频率按「24 小时一次」实现，并且写死在文档里

不是每轮跑（600s 一轮会有 144 次/天，太频繁），也不是纯手动。
判定用 `data/qa-usage.json` 的 `lastHealthAt`：

```json
"qaHealth": { "enabled": true, "everyHours": 24, "autoPurge": true }
```

| 想改的行为 | 怎么改 |
|---|---|
| 只报警不动数据 | `autoPurge: false` |
| 彻底关掉 | `enabled: false` |
| 改成更频繁 | `everyHours` 调小 —— **但必须先问用户**（已写进 SKILL.md 硬约束 33 和配置 note） |

### 24.2 一份实现，两处调用

`lib/qa-health.mjs` 抽出来，`qa-admin purge-tag`（手动）与 `collect.mjs` 第 0b 步（每天自动）共用：

```
tagsFromConfig(config)     签名 → [完整签名, 去书名号内文, 版主助手, 小鲸鱼]
scanTagged(raw, tags)      只查每块 --- 之后的正文；元数据里的「摘自」不算
purgeTagged({..., apply})  体检 / 剔除 + 归档 + 备份
shouldHealthCheck(usage)   24h 频率判断
```

守护进程日志（首轮实测，13:02:43）：

```
== 2026/10/28 13:02:43 本轮开始（答疑库 20 条，目标最新 8 条）
  [体检] 答疑库干净（20 条，无自己标签条目）
```

`data/qa-usage.json` 记下 `lastHealthAt = 2026-10-28T05:02:44Z`，24 小时内不会再跑。

### 24.3 新增测试 `test-qa-health.mjs`（35 条断言）

| 组 | 锁住什么 |
|---|---|
| `tagsFromConfig` | 签名改了也能推出来；没配签名还有兜底 |
| `scanTagged` | 命中带标签正文；**标签只在「摘自」行不算命中**（防误伤）；真实答案 + 我的「补充：」整条剔除 |
| `renderLibrary` | 拼回去不丢 header、不丢正常条目 |
| `purgeTagged` 默认 | 只报不写：主库字节不变、不生成归档 |
| `purgeTagged --apply` | 移动不删除、归档保留原文、备份生成、再体检变干净 |
| `shouldHealthCheck` | 没跑过=跑；1h/23h 不跑；24h/25h 跑；可配置周期；时间戳坏了当该跑 |

### 24.4 顺带发现的一个非阻塞问题

这一轮夸奖「子昂丿」时表情插入失败（`{"want":"比心","actual":[]}`），
**安全阀按预期工作**：没插上表情就不发送，转人工，绝不发错内容。
这是表情点选的偶发抖动（同轮另一条夸奖成功），不是新引入的问题；
失败后 `praised` 保持 false，帖子还在窗口内的话下一轮会重试。

### 24.5 验证

```
7 套全绿：
  test-question 38/38   test-praise 34/34   test-variants 60/60
  test-match    18/18   test-summarize 27/27  test-archive 17/17
  test-qa-health 35/35
三方一致性（7 个改动文件 + 答疑库 SHA256）：0 差异
答疑库 22 条（本轮新沉淀 2 条），含签名条目 0
守护进程在跑（pwsh-5），13:02 首轮 [体检] 已触发
```

## 25. skill 整理（2026-10-28 13:45）

用户要求：「**整理一下skill。是否重复，或者不合适的优化一下。脚本可以复用的，就优先复用。**」
并追加一问：「**如果不适合作为skill，是否建议作为软件。或者其他形式。**」

### 25.1 先做审计，不凭印象改

写了两个一次性审计脚本（跑完删除），扫全 skill：

```
文件清单：48 个文件 / 8284 行
导出符号：逐个算「全仓库（含定义文件内部）被引用几次」→ 真正没人用的 7 个
同名函数跨文件重复：hashOf（praise + variants）、entryKeyOf（collect + post-admin）
CLI 子命令：13 个脚本
```

### 25.2 发现一：emoji.mjs 有一整段「从未被调用、而且基于已证伪假设」的代码

`lib/emoji.mjs` 有两套表情实现：

| | 顶层版（非 scope） | scope 版 |
|---|---|---|
| 用在哪 | `replier.mjs` → 帖子顶层回复 | **没有任何地方调用** |
| 表情面板在哪 | 页面级 `.tap-editor-emoji__popover` | 注释写「渲染在工具栏项内部，不是 body 级 portal」 |

scope 版（`setCaretIn` / `readEmojisIn` / `isPanelOpenIn` / `openEmojiPanelIn` / `clickEmojiIn` /
`appendEmojiAtEnd`）**从未被调用过**，而且它的核心假设（面板在工具栏内部）后来被
`reply-nested.mjs` 的实测**证伪**（真实情况是页面级 portal）。

最要命的是：`reply-nested.mjs`（328 行）**自己实现了一遍**表情逻辑 —— 所以
「看起来有模块、实际没复用」，而且留着的那份还是错的。留着只会让下一个人照着错的路走。

**处置**：删掉整段 scope 版 + 5 个未用工具函数（`splitEmojiSuffix` / `emojiNamesIn` /
`clearEditor` / `selectEmojiTab` / `listPanelEmojis`），共 **-7504 字符**。
真正在跑的 `reply-nested.mjs` 那份**一个字没动**（它是实测验证过的）。

### 25.3 发现二：散列函数抄了 4 份、entryKeyOf 抄了 3 份

| 重复物 | 原样 | 处置 |
|---|---|---|
| `hashOf` | praise.mjs、variants.mjs 各一份 | 抽到新文件 `lib/util.mjs` → `stableHash` |
| `liteHash` / `hashTextLite` | praise.mjs、variants.mjs 各一份（算法完全相同） | 同上 → `liteHash`，`variants.mjs` 不再 re-export 别名，4 个引用方一起改 |
| `entryKeyOf` / `slugOf` | collect.mjs、post-admin.mjs、qa-admin.mjs 各一份（**三份一模一样**） | 统一到 `lib/usage.mjs` → `entryKeyOf` |

> 这类重复的真实风险不是「难看」，而是**改一边忘另一边**：
> `entryKeyOf` 三份如果只有一份改了 key 格式，同一条目会被算成两条，引用统计和 30 天归档判断一起错。

### 25.4 发现三：verify-others.mjs 是 post-admin recheck 的早期草稿

`verify-others.mjs`（75 行）做的是「读评论 → 总结 → 入库 → 标记已回复」，
而 `post-admin.mjs recheck <id>` 现在做的是同一套（还多了按当前规则重判）。
前者是后者的**旧版本**，留着只会让人用错入口 → **删除**。

### 25.5 发现四：死代码 + 文档残留

- `lib/replier.mjs` 的 `calibrate`（只是打印页面结构）→ `probe-dom.mjs eval` 已经能做 → 删
- `SKILL.md` 里两处提到 `verify-others.mjs` → 删
- `output/README.md` 里的自检数字全过时（18/23/35 条）+ **还写着旧的客服腔文案范例** → 更新
- `references/ops.md` 分发排除清单补上 `qa/答疑库.md.before-*`、`qa/归档/`

### 25.6 整理结果

```
改动文件：13 个
死导出：7 → 0
同名重复函数：2 处 → 0
文件数：48 → 49（新增 lib/util.mjs，删除 scripts/verify-others.mjs）
代码行数：8284 → 约 8010（emoji 死代码 -190 行，verify-others -75 行）
三方一致性：49 个文件逐个 SHA256 → 0 差异
7 套测试全绿：38/34/60/18/27/17/35
守护进程重启后首轮正常（13:45:40，22 条，0 报错）
```

### 25.7 关于「要不要做成软件」—— 结论与建议

**先看事实：这个工具的每一步都是确定性的，没有一步需要 AI 推理。**

```
抓取(1 请求) → 判定(规则表) → 匹配(打分公式) → 组文案(模板池)
   → 开浏览器 → fill → 点表情 → 发送 → 出报表
```

真正需要「理解」的只剩两处，而且都已经落地成规则了：
① 库里没有的问题 → 转人工；② 口吻 → 18/16/16 套模板 + 近期避重。

而 AI 层真正不可替代的价值是另一面：**临时判断、临时口吻微调、事故排查**。
所以正确做法不是「砍掉 skill」，也不是「把 skill 变成软件」，而是**分层**：

```
┌─ 核心引擎（纯 Node，零第三方依赖，无 AI）──────────────────┐
│  daemon / once / report / doctor / qa-admin / post-admin   │
│  答疑库（单一数据源）                                        │
└──────────────────────────────────────────────────────────┘
┌─ skill（DSH 专用）────────────────────────────────────────┐
│  SKILL.md = 判断规则 + 口吻规范 + 踩坑清单（给 AI 读）        │
│  薄封装：把自然语言意图映射到核心 CLI 的子命令                │
└──────────────────────────────────────────────────────────┘
```

理由（都来自本项目的实测，不是理论）：

| 事实 | 对形态的含义 |
|---|---|
| 回复只能靠**本地已登录的 Chrome + 浏览器扩展**（官方 CLI 只读） | 云端 / SaaS 做不了，形态必须是「本地程序」 |
| Session 0 看不到桌面 Chrome（实测） | Windows 服务不可行，只能计划任务 AtLogOn |
| 零第三方依赖、纯 Node、7 套测试 | 天然适合做成独立 CLI，甚至 npm 包 |
| 其他成员**大概率不装 DSH** | 给 skill = 要求他们也装 DSH、也读 Markdown 手册，门槛高了一档 |
| 答疑库必须**单源**（用户反复强调） | 答疑库必须只存在于核心引擎里，skill 引用它而不是各存一份 |

**明确不建议的形态**（并给理由，避免以后重复讨论）：

| 形态 | 为什么不做 |
|---|---|
| Electron / Tauri 桌面应用 | 为跑一个定时脚本引入几百 MB 运行时；且登录态仍要靠系统浏览器，桌面壳解决不了登录问题 |
| Windows 服务 | Session 0 看不到桌面 Chrome，已实测 |
| 云端 / SaaS | TapTap 无公开写接口，只能本地浏览器自动化 |
| IM / 机器人网关 | 偏离目标场景（用户要的就是论坛本身） |

**建议路线（分阶段，按成本递增）**：

| 阶段 | 内容 | 成本 | 收益 |
|---|---|---|---|
| 0（已完成） | skill 形态可用，1 人使用 | — | — |
| 1 | 给核心 CLI 补 `install`（生成 config、检测 opencli/扩展、跑 doctor）+ 一份给人看的 README | 小（1~2 h） | **不装 DSH 的成员也能用**；分发从「拷目录」变成「跑一条命令」 |
| 2 | 答疑库独立成 git 仓库，引擎从 git 拉/更新 | 中 | 彻底解决「答疑库单源 + 多人同步」 |
| 3 | 做成真正的 npm 包（`bin` 命令） | 大 | 版本化、`npx` 即用 |

**待用户定的关键岔路**：其他成员到底装不装 DSH？
- 装 → 阶段 1/2 可以缓，skill 形态够用，把精力放答疑库质量上
- 不装 → 阶段 1 必须做（否则他们根本用不了），且 skill 应降级为「AI 专用层」

**用户的答复**：「少部分有 DSH。按照顺序来吧，主要我一个人改的太慢了，先有一个基础版本。
我希望发布到 github.com（已登录），大家一起改。」

→ 所以真正的目标是 **发布可协作的仓库**，瓶颈是「答疑库一个人改太慢」。

## 26. 发布到 GitHub（2026-10-28 15:40）

仓库：**https://github.com/WangXZo/taptap-pvz2-forum-moderator** （public，main，61 个文件）

### 26.1 为协作做的三件事

| 要做的事 | 落地 |
|---|---|
| 让人**认领**任务而不是瞎补 | `qa/待补充问题.md`：从 `report-gaps` 生成的真实未命中问题（10 条）+ 认领表 + 问答格式 + 三条硬要求 |
| 让人**装得上** | `scripts/install.mjs`（一键：查环境/补配置/建目录/跑自检）、`scripts/doctor.mjs`（只读体检 7 项，每条问题都给修法） |
| 让**两份答疑库不打架** | `scripts/qa-sync.mjs`：按「来源链接」合并，`--status` 看差异，`--to-repo`/`--to-runtime` 选方向，`--apply` 才写 |

`qa-sync` 解决的是**协作场景的新坑**：仓库副本（人改，PR）和运行中副本（守护进程自动沉淀）
会同时增长，谁覆盖谁都会丢东西 —— 这正是之前「一夜沉淀 10 条全丢」那个事故的同源问题。

### 26.2 仓库骨架

```
README.md          给人看的（三步跑起来 / 能做什么不能做什么 / 多人协作须知）
CONTRIBUTING.md    认领流程 + 代码约定 + 提交前自查
SKILL.md           给 AI 读（判断规则 / 口吻规范 / 硬约束 / 踩坑）
LICENSE            MIT
package.json       npm 包雏形（test / doctor / start / dry-run 脚本）
.gitignore         data/ reports/ logs/ 备份文件一律不进库
.gitattributes     仓库一律 LF，只有 .ps1/.cmd 强制 CRLF（Windows 踩过的坑）
scripts/           代码（lib/ 在下面）
references/        接口 / 表情 / 选择器 / 判定规则 / 运维 / 管理工具
qa/答疑库.md        ★ 协作核心
qa/待补充问题.md    ★ 认领清单
qa/归档/           剔除的坏条目留档
docs/方案.md · docs/github-survey.md
```

### 26.3 个人信息脱敏（用户明确要求）

用户看过仓库后说：**「包含个人信息，请只推送 skill」**。

扫描发现并清理：

| 位置 | 原内容 | 处理 |
|---|---|---|
| `scripts/config.json` | `"myUserId": "63****64"`（真实 TapTap ID） | **清空**，改用 `__note` 指引跑 `whoami.mjs` 自己填 |
| `qa/答疑库.md` 17 条 | `- 摘自：枫之谷_XZo（版主）` | → `- 摘自：版主`（保留角色，去掉昵称） |
| `qa/归档/坏条目` 9 条 | 同上 | 同上 |
| `scripts/test-summarize.mjs` | `const ME = '63****64'` | → `'99999'`（假 ID，加注释说明） |
| 测试/文档 6 处 | 作者名 `枫之谷_XZo` | → `版主` |
| 答疑库正文 1 处 | 「依星&寻梦补充过」 | → 「社区玩家补充过」 |
| 归档正文 2 处 | 「依星&寻梦 说得又准又细…」 | → 「某玩家 说得又准又细…」 |

保留的：`LICENSE` 与 `package.json` 里的 **GitHub 账号名 `WangXZo`** —— 公开仓库必然带 owner 信息。

复查（全仓 grep）：`63****64` / `枫之谷` / `依星` / `涅瀮` / `杯哲` / 本地真实路径 / 邮箱 → **全部 0 命中**。
脱敏后 7 套测试全绿，功能未受影响。

### 26.4 关于「旧提交里还有 user_id」

第一次推送的提交（`37a12a7`）里带着真实 user_id。处理方式：

```
git commit --amend           → 2e109b9（脱敏后的版本）
git push --force origin main → + 37a12a7...2e109b9 main -> main (forced update)
```

旧提交已从分支历史移除，成为 GitHub 上不可达对象（会在其 GC 周期后清理）。
**如果要求「绝对干净」，最稳妥是删库重建** —— 需要用户决定，我没有擅自删。

### 26.5 踩到的坑（都记下来免得重复）

| 坑 | 现象 | 解法 |
|---|---|---|
| winget 装 gh 失败 | `InternetOpenUrl() failed 0x80072efd` | 直接下 release zip 解压，免安装、不用管理员 |
| `gh` 不走系统代理 | `Post github.com/login/oauth/access_token` 连不上 | 该端点直连被挡；本机 `api.github.com` 反而直连通 |
| opencli 会话冲突 | 我的 GitHub 探针与 TapTap 守护进程抢同一 session → 挂起 | 换独立 session（`gh`），别用守护进程那个 |
| `export { x as y } from` 不产生本地绑定 | 模块内引用 `y` 报 `not defined` | 改成 `import` + `export`，并把 4 个引用方一起改名 |
| doctor 把「文件」当「目录」检查 | `data/qa-usage.json` 报「目录不存在」 | 按扩展名区分，文件不存在只提示「第一次跑会自动生成」 |

### 26.6 验证

```
7 套测试全绿：38/34/60/18/27/17/35
远端实测：scripts/config.json 的 myUserId = ''（已清空）
         qa/答疑库.md 的 - 摘自：社区玩家（昵称已脱敏）
force push 已生效：37a12a7 → 2e109b9
```

## 27. 二次脱敏：改为遮罩式 + 删库重建（2026-10-29）

用户否掉了我的第一版做法，两条纠正：

1. **「注意是脱敏处理，并不是移除。」**
   —— 我原先把昵称换成了角色标签（`- 摘自：社区玩家`），这是**移除**，丢了「谁答的」这个信息。
2. **遮罩规则（用户指定）**：
   > 中间替换为 `*`，保留首、尾（前后均保留 1~3 位），
   > 为防止长度判断，在中间添加 `*` 补足统一长度（建议 8 位），保留的字符不能超过 50%。

### 27.1 遮罩实现

```js
总长固定 8
原文 ≥ 6 字 → 首 2 + `****` + 尾 2  = 8（保留 4/8 = 50%）
原文 2~5 字 → 首 1 + `******` + 尾 1 = 8（保留 2/8 = 25%）
原文 1 字   → 全遮 `********`
```

实测效果：

```
枫之谷_XZo   →  枫之****Zo（版主）
依星&寻梦    →  依******梦
123          →  1******3（答疑智多星）
63****64      →  63****64
4561605471   →  45****71
```

**为什么必须统一 8 位**：不统一的话 `*` 的个数就是原文长度，等于把长度信息漏出去了。

### 27.2 两类例外：换假值，不遮罩

| 场景 | 处理 | 原因 |
|---|---|---|
| **规则示例 / 测试数据** | 换成 `1234567890` / `99999` | 遮罩值带 `*`，就不再是「纯数字 ID」，`test-question` 直接失败（实测 `22****26` 被判成提问） |
| **运行时必填项** `config.json` 的 `myUserId` | 存遮罩值，但 `doctor.mjs` **拦截含 `*` 的值** | 遮罩 ID 会让「我是否已回复」恒判为否 → 重复回复 |

### 27.3 ⚠️ 中途踩的大坑：批量替换把数字 `1` 全换成了 `2`

第一版脱敏脚本用了一批过宽的替换规则，结果把文件里的数字 `1` 批量变成了 `2`：

```
summarize.mjs：t.length < 12      →  < 22     ← 有效回答门槛变了
              len <= 120          →  <= 220
              s += 1 / s -= 1     →  s += 2 / s -= 2
report-gaps： b[1] - a[1]         →  b[2] - a[2]   ← 排序直接错
              Math.min(fresh, 10) →  20
test-summarize：mk('1','10') → mk('2','20')、moment/123 → moment/223
```

**症状**：只有 2 套测试变红（`test-praise 32/34`、`test-summarize 25/27`），
但**库代码的阈值已经悄悄错了** —— 如果只看「测试大部分通过」就发布，等于发了个打分逻辑坏掉的版本。

**处置**：
1. `git checkout HEAD -- scripts references SKILL.md` 全部回滚到干净提交
2. 重写脱敏脚本：**每处替换锚定完整字符串 + 断言命中次数**，次数不符就整体不写入
3. 复查关键阈值（`< 12`、`<= 120`、`s += 1`、`b[1] - a[1]`、`Math.min(fresh,10)`）逐个确认

**教训**：批量文本替换必须「断言命中数 + 拒绝部分写入」。
只报「改了几个文件」是不够的 —— 这次就是「改对了文件、改错了内容」。

### 27.4 删库重建（用户要求彻底清史）

`gh repo delete` 失败：`HTTP 403 Must have admin rights` —— 令牌缺 `delete_repo` scope。
用户选择**自己在浏览器里删**（Settings → Danger Zone），删完确认 404。

重建时不再带旧历史：

```bash
git checkout --orphan clean-main     # 孤儿分支：全新根提交
git add -A && git commit             # 62 文件 / 9733 行
git branch -D main && git branch -m main
git reflog expire --expire=now --all && git gc --prune=now   # 清掉本地含真实值的旧对象
gh repo create taptap-pvz2-forum-moderator --public --source=. --remote=origin
git push -u origin main
```

本地旧对象已确认不可读：`37a12a7` / `2e109b9` / `d4388cb` 三个提交全部 `cat-file -e` 失败。

### 27.5 脱敏规范已写入 skill

| 位置 | 内容 |
|---|---|
| `SKILL.md` 开头「🔒 脱敏规范（所有贡献者必读）」 | 五节：绝不写明文 / 遮罩格式 / 两类例外 / 可保留的 / 自查命令 |
| `README.md` 首屏 | 醒目提示 + 遮罩示例（用假例子，不用真实值） |
| `CONTRIBUTING.md` 「第 0 条」 | 表格：不能写什么、怎么写 |
| `qa/归档/脱敏记录.md` | 规则与落点，**刻意不记录任何原始值** |
| `scripts/doctor.mjs` | 检测 `myUserId` 含 `*` 就报错，阻止静默重复回复 |

> 写文档时的坑：**遮罩示例不能用真实值**。
> 我第一版在 README/SKILL 里写「`依星&寻梦 → 依******梦`」，等于把原值与遮罩值配成对，
> 反而暴露了。已全部换成 `玩家昵称示例 → 玩家****示例` 这类假例子。

### 27.6 端到端验证（全新克隆，最硬的方式）

```bash
git clone --depth 1 https://github.com/WangXZo/taptap-pvz2-forum-moderator.git
```

```
提交数：1                              ← 历史只有一条
文件数：62
全仓真实值扫描：0 命中
7 套测试：38/34/60/18/27/17/35 全绿
doctor：✗ myUserId 是脱敏值（含 *），不能直接跑   ← 拦截生效
```

远端抽查：

```
scripts/config.json   "myUserId": "63****64"
qa/答疑库.md          - 摘自：枫之****Zo（版主）
                      - 摘自：1******3（答疑智多星）
```

### 27.7 两份副本的定位（保持既有模型）

| 副本 | 位置 | 内容 |
|---|---|---|
| **运行中**（本机） | `~/.dsh/skills/taptap-pvz2-forum-moderator/` | **真实** user_id + 真实昵称，守护进程用这份 |
| **发布**（GitHub） | 仓库 | 全部遮罩，供协作 |

代码双向同步（`scripts/` 40 个文件），但 `config.json` 与 `qa/答疑库.md` **不跟着同步**
—— 一份要真值才能跑，一份要遮罩才能公开。

### 27.8 附带约定

用户指定：**以后要 clone 的 git 仓库统一放 `E:\work\AI\deepseek-workspace\github\`**。
该目录已存在（当前为空）。














