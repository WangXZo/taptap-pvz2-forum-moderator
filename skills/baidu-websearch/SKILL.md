---
name: baidu-websearch
description: 百度联网搜索（无凭据、全自动，只负责「查 + 整理」）：抓百度结果页 → 从 HTML 内嵌的 sseApi 自动取签名 → 调 SSE 接口拿到百度「AI 搜索」生成的答案 + 引用链接（mode=answer）；没 sseApi 时自动退回整理好的普通搜索结果页（标题/摘要/链接/页面片段，mode=page）；两者都没有则返回失败原因（风控/HTTP 错/搜不到）。返回的 mode 标清来源，具体怎么用由调用方决定。内置单轮查询上限与限速。当需要联网查实时资料、官方公告、公告原文、攻略、版本/活动信息、名词解释等外部信息时使用。不需要登录、不需要 cookie、不需要 API key。
---

# 百度 AI 搜索（结果页 → 自动签名 → 生成答案）

> 定位：给任何 agent / 脚本一个**不需要任何凭据**的联网搜索能力。
> 一句话：**抓一次百度结果页，就能拿到它内嵌的 AI 搜索地址（含签名），再 POST 它就能得到一段生成好的答案。**

## 它解决什么问题

普通「抓搜索结果页」有两个毛病：广告多、只有标题链接、指向性差。
百度自己的「AI 搜索」能给出一段现成答案，但那个接口
`chat-ws.baidu.com/baikan/conversation` 需要 `k_signature` / `k_timestamp` / `pmgr_token`。

**关键发现（实测）**：这三个签名参数不用手工弄 —— 普通结果页 HTML 里就内嵌了完整地址：

```json
"sseApi":"https://chat-ws.baidu.com/baikan/conversation
   ?inputMethod=chat_search
   &k_signature=<自动生成的签名>
   &k_timestamp=<每次抓页都不同>
   &word=<URL 编码后的查询词>
   &pmgr_token=<自动生成>
   &llmsearch=1"
```

所以整条链路全自动：

```
① GET  https://www.baidu.com/s?...&wd=<编码后的查询>      匿名，~1.5s
   └─ 正则抠出 "sseApi":"…"
② POST 那个 sseApi（原样用，一个字都不用改）              ~5~9s，流式
   └─ text/event-stream → 拼 data.message.content.generator.data.value 分片 → 答案
```

## ⚠️ 重要：sseApi 是**偶发**的

同一个查询词，两次抓结果页可能一次有、一次没有（页面版本抖动，实测 1.0MB 页面有 / 699KB 页面没有，跟查询词无关）。
所以**不能**把「有 sseApi」当成必然，必须走降级链：

```
① 有 sseApi           → 拿 AI 答案（首选）
② 没 sseApi           → 隔 1.5s 再抓一次结果页（重试 1 次，大概率能拿到）
③ 还是没有            → 返回整理好的普通结果页（标题 + 链接 + 页面片段）  ← 算成功
④ 结果页也没内容      → 返回失败 + 原因（被风控 / HTTP 错 / 搜不到）      ← 才算失败
```

调用方只需要看返回的 `ok` / `mode` / `reason`，不用自己重试。

## 实测结论（2026-11-11）

| 项 | 结果 |
|---|---|
| 结果页 | 200，约 1.0~1.4 MB，**1.0~2.4s** |
| SSE 接口 | 200，**5~9s**（偶尔十几秒） |
| 需要登录？ | **不需要** |
| 需要 cookie？ | **不需要**（实测不带 cookie 反而更快：853ms vs 9337ms） |
| 签名会过期？ | **不会困扰你** —— 每次抓结果页都是新签名（`k_timestamp` 每次都变） |
| sseApi 一定有？ | **不一定**，偶发缺失 → 见上面降级链 |
| 会不会被拦 | 暂未遇到；触发验证码时有 `百度安全验证` 特征词，代码里已检测 |

## 用法（CLI）

```bash
# 默认 auto：答案优先，没有就退结果页
node scripts/websearch.mjs --q "潘妮秘宝心仪植物多久刷新一次"

# 只抓结果页（快，1~2s；标题 + 链接 + 能抠到的片段）
node scripts/websearch.mjs --q "植物大战僵尸2 无敌树根" --mode page

# 机器可读
node scripts/websearch.mjs --q "…" --json

# 把 SSE 原始流落盘（百度改版后调正则用）
node scripts/websearch.mjs --q "…" --dump raw.txt

# 不占单轮配额（调试用）
node scripts/websearch.mjs --q "…" --no-quota
```

退出码：`0` 成功（answer 或 page 都算）/ `2` 失败。

## 作为库调用（推荐）

```js
import { search, resetRound, quotaLeft } from './scripts/websearch.mjs';

resetRound();                       // 每轮业务处理开头调一次，重置查询配额
const r = await search('某个问题');  // 默认 auto

if (r.ok && r.mode === 'answer') {
  console.log(r.text);              // 整理好的「AI 答案 + 参考链接」
} else if (r.ok && r.mode === 'page') {
  console.log(r.text);              // 整理好的「结果列表 + 页面片段」
} else {
  console.log(`没查到：${r.detail}`); // reason: quota|blocked|http|error|empty
}
```

### `search(q, opts)` 返回值

| 字段 | 说明 |
|---|---|
| `ok` | 拿到答案或结果页内容 → `true`；两者都没有 → `false` |
| `mode` | `'answer'`（AI 答案）/ `'page'`（普通结果页）/ `'none'`（失败） |
| `reason` | 失败原因：`quota` 配额用完 / `blocked` 被风控 / `http` / `error` / `empty` |
| `detail` | 一句中文说明，可直接打日志或给人看 |
| `text` | **整理好的可读文本**（answer/page 都有，直接用这个） |
| `answer` / `refs` | AI 答案正文 / 引用链接（mode=answer 时） |
| `results` / `snippets` | 结果页条目 `{title,url,abstract}` / 页面片段（mode=page 时） |
| `attempts` / `ms` | 抓了几次结果页 / 总耗时 |

`opts`：

| 选项 | 默认 | 说明 |
|---|---|---|
| `mode` | `'auto'` | `auto` / `answer`（需 `sseApi`）/ `page` |
| `timeoutMs` | `60000` | 等答案的**软**上限；到点保留已收到的部分（见下） |
| `useQuota` | `true` | 是否占单轮配额 |
| `dump` | `''` | 把 SSE 原始流落盘路径 |

底层函数（一般不用，调试/排查时才用）：`fetchSerp(q)`、`fetchAnswer(sseApi, q, opts)`、`buildPageText(q, page)`、`buildAnswerText(q, ans)`。

## 限流（重要，别把人家服务打崩）

- **单轮查询上限 2 次**（`MAX_QUERIES_PER_ROUND = 2`）。模块内计数，`resetRound()` 清零，`quotaLeft()` 查剩余。
  超了直接返回 `reason: 'quota'`，**不发请求**。
- 两次查询之间最小间隔 **3s**（`MIN_GAP_MS`），代码内部自动 sleep。
- 「同一个查询没拿到 sseApi 而重抓一次」**不额外占配额**（它属于同一次查询）。
- 调试时可 `--no-quota` 绕过，但别在业务里这么用。

## 答案是怎么等出来的（流式，不硬砍）

SSE 是**增量分片**的，所以 `fetchAnswer` 用 **流式读取**：

- 一边收一边拼 `value` 分片，不做「收完才解析」；
- 到 `timeoutMs` 软上限就**停止读取，把已经收到的部分当答案返回**（`partial: true`，尾部引用可能缺）；
- 连接中途被断（`AbortError` / socket 断）也**保留已收到的部分**，不整段丢。

> 历史坑：早期用 `AbortController` 硬砍 + `r.text()` 一次性读，8s 一刀切下去连已经流出来的答案一起丢，白查。

## 返回的到底是哪种结果（本 skill 只负责「查 + 整理」）

`mode` 直接标明来源，别把两者混着用：

| mode | 来源 | `text` 长什么样 |
|---|---|---|
| `answer` | 百度自己的「AI 搜索」**生成答案** | 以 `【百度 AI 搜索·生成答案】` 开头，末尾带「参考链接」 |
| `page` | 普通**抓搜索结果页**整理 | 以 `【百度搜索结果页】` 开头，只有标题 / 摘要 / 链接 / 页面片段 |
| `none` | 没查到 | 空，看 `reason` + `detail` |

这两者**可信度不同**：`answer` 是百度 AI 综合出来的说法，`page` 只是网页标题拼起来的线索。
**怎么用、用什么口径讲，是调用方的事** —— 本 skill 只负责查准、整理好、标清来源，不预设任何业务话术。

## 坑（都踩过）

1. **答案字段是增量分片**：`data.message.content.generator.data.value` 要**按顺序拼接**，不是整段。
2. **答案里带标记**要清掉：`^22^`（引用角标）、`==加粗==`、`:ml-search[实体]{id=…}`、`:ml-intent[…]`。
3. **结果页摘要多是 JS 渲染的**：`c-abstract` 经常 0 条命中，只能从 `h3` 后一小段里捞，捞不到的条目就没有摘要——`text` 里会少这一行，属正常。
4. **`baidu.php?url=…` 是跳转链接**，很长；文本输出里已截断到 110 字符，要真实地址再跟一次 302。
5. **结果页混广告**：`扫码下载` / `百度图片` / `视频大全` / `极速下载` 这类标题在整理文本时已过滤（JSON 里保留原样）。
6. **百度会改 HTML 结构**：抠 `sseApi` 的正则失效时，用 `--dump` 存原始流对照；最差退回 `--mode page`。
7. **`k_signature` 与 `word` 绑定**：查询词在 URL 里。要换问题就**重新抓一次结果页**，不要改 URL 里的 word 复用签名。
8. **别高频打**：见上面「限流」。

## 需要人工验证时

- 结果页出现「百度安全验证 / 请完成下方验证 / 异常流量」→ 说明被风控了。`reason: 'blocked'`。
  此时**停手**，别重试刷分；换时间或人肉在浏览器过一下验证。
- 本 skill 不处理验证码绕过。遇到就降级（只用缓存结果或告诉用户搜不到）。

## 目录

```
baidu-websearch/
├── SKILL.md
└── scripts/
    └── websearch.mjs     # 全部逻辑（零依赖，node ≥18 有 fetch 即可）
```

## 依赖关系

本 skill **没有任何业务依赖**，也不知道谁在用：只对外暴露 `search()` / `fetchSerp()` / `fetchAnswer()`。

调用方怎么接入是**调用方自己的事**，本 skill 不预设、不记录：

- 装到 `~/.dsh/skills/baidu-websearch/`（或任意路径，用环境变量 `DSH_BAIDU_WEBSEARCH` 指过去）
- 调 `search()`，看 `mode` 和 `text`，**怎么用、用什么口径讲由调用方决定**
- 找不到本 skill 时，调用方**应当按自己的正常流程处理**（比如转人工），不能因为「没装搜索」就报错或卡住