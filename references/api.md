# TapTap 社区接口实测手册

> 全部来自实机抓包与逆向，**不要凭猜**。参数一旦报错，照本表核对。

## 1. 基础信息

| 项 | 值 |
|---|---|
| Host | `https://www.taptap.cn/webapiv2` |
| 必需请求头 | `X-UA: V=1&PN=WebApp&LANG=zh_CN&VN_CODE=102&VN=3.62.0&LOC=CN&PLT=PC&DS=Android&OS=Windows&OSV=10&DT=PC&CH=chrome` |
| 其它头 | `User-Agent`（普通 Chrome UA 即可）、`Accept: application/json` |
| 登录态 | 读接口匿名可读；写接口需登录 Cookie |

**缺 X-UA 会报**：`INVALID_XUA: XUA is empty`

## 2. 关键接口

| 用途 | 路径 | 方法 | 认证 |
|---|---|---|---|
| 论坛帖子流 | `/feed/v7/by-group` | GET | 匿名 |
| 论坛内搜索 | `/forum-feed-search/v1/by-keyword` | GET | 匿名 |
| 帖子回复列表 | `/moment-comment/v1/by-moment` | GET | 匿名 |
| 按 App 帖子流 | `/feeds/v2/by-app`、`/feeds/v3/by-app` | GET | 匿名但实测返回空 |
| **发回复** | `/moment-comment/v1/create` | POST (multipart) | 需登录 Cookie + `x-xsrf-token` |
| 楼中楼回复 | `/moment-comment/v1/create-child` | POST (multipart) | 需登录 Cookie + `x-xsrf-token` |
| **移除（出板块）** | `/moment/v3/unlink-group` | POST (multipart) | 需登录 Cookie + `x-xsrf-token` |

## 3. `/feed/v7/by-group` 参数（最重要）

| 参数 | 说明 |
|---|---|
| `group_id` | 论坛 ID，**≠ app_id**。PVZ2 = `40173`，app_id = `54031` |
| `from` | offset 偏移，步长 = limit |
| `limit` | **最大 10**（15/20 报 `Field validation for 'limit' failed on the 'max' tag`） |
| `sort` | `created`（发布时间降序）/ `commented`（回复时间）/ `default`（默认推荐） |
| `status` | `0` |
| `type` | `feed` |
| `with_hot_comment` | `true` |

### `/moment-comment/v1/by-moment` 参数（读回复）

| 参数 | 说明 |
|---|---|
| `moment_id` | 帖子 ID（19 位字符串，禁止转数字） |
| `from` | offset |
| `limit` | **最大 30**（50 报 `ByMomentRequest.limit failed on the 'max' tag`） |

返回 `{ list, total }`；`list[].child_posts[]` 是楼中楼；`total` 只统计一级回复。

### 排序参数怎么来的

官方页面右上角排序菜单有「默认排序 / 回复时间 / 发布时间」三项，对应 URL query `?sort=`，前端透传给 API：

- `sort=created` → **按发布时间严格降序**（实测 publish_time 1792995053 → 1792974111 完全有序）
- `sort=commented` → 按回复时间
- `sort=default` → 推荐混合序，**不是时间序**（实测 publish_time 明显乱序）

> ⚠️ 用 `sort=default` 拿到的数据不是按发布时间排的。想要「最新 N 条」必须用 `sort=created`。

### 排序选项不在接口返回里

`/feed/v7/by-group` 的响应 `data` 只有 `list / total / next_page` 三个字段，**不含排序选项**。排序参数是前端硬编码的，查接口返回是找不到的。

## 4. 帖子对象结构

```
item.moment.id_str          帖子ID（19位字符串，禁止转数字，会丢精度）
item.moment.topic.title     标题（长贴有；图文动态为 null）
item.moment.topic.summary   正文摘要
item.moment.topic.type      1=长贴  2=图文动态
item.moment.publish_time    发布时间（Unix 秒）
item.moment.commented_time  最后回复时间（Unix 秒）
item.moment.created_time    创建时间
item.moment.stat.comments     回复数（★ 顶层 item.comment_count 不存在，别用那个）
item.moment.stat.pv_total / ups / play_total
item.moment.author.user.name / id / is_moderator
item.moment.group_label     子版块（可能为 null）
```

回复对象：

```
comment.id_str / created_time
comment.author.id / name
comment.contents.json        富文本数组，需自己摊平
comment.child_posts[]        楼中楼，含 parent_post_id
comment.reply_to_user        被回复者
```

## 5. group_id 怎么找

1. 打开 `https://www.taptap.cn/app/<appId>/topic`，页面 SSR 里有帖子列表
2. 在 HTML 的 `__NUXT_DATA__` 附近找 `feed/v7/by-group?...group_id=NNNNN`
3. 或者用浏览器抓一次请求：`opencli browser <session> network`

## 6. WAF（阿里云）

触发条件：短时间请求过密。

返回特征：**HTTP 200，但内容是 HTML**：

```html
<!doctype html><meta name="aliyun_waf_aa" content="ff926c7f07e45e2e487a29c6197d3460">
```

- curl 与 Node fetch **同时被拦** → IP 级封禁
- 实测封禁持续 **>25 分钟**未恢复
- 对策：单次运行 1 个列表请求、间隔 ≥10 分钟、页间 ≥1.5s；命中拦截页时退避 15s/30s/45s 后跳过本轮
- **浏览器（真实 Chrome + 登录 Cookie）不受此 WAF 影响**，可作兜底采集通道

## 7. 官方 CLI 能做什么

`taptap-cli community-management` 共 8 个方法，**全部只读**：

```
list-community-moments / get-community-moment
list-community-moment-replies / list-community-moment-child-replies
list-community-group-labels
get-community-moment-video-upload-token
complete-community-moment-video-upload
upload-community-moment-image
```

- 需要 `developer_id` + `app_id`，即**该游戏的开发者权限**
- `list-community-moments` 支持 `--moment-intent`（`1`=问答求助，`2`=反馈建议），是官方意图标签，比关键词识别准得多
- 官方 skill 原文：「要发帖、回帖、置顶、加精、删除或处理内容 → **CLI 不支持写**」

拿到开发者权限后，读接口可以换成 CLI，识别质量会明显提升。

## 8. 写接口（2026-10-30 实测可用）

> 实现见 `scripts/lib/taptap-api.mjs`。**所有写操作走这条，点 UI 只作兜底。**

### 8.1 怎么带鉴权（关键）

写接口要登录 Cookie，其中 `TAPTAP_SESSION` 是 **HttpOnly**（`document.cookie` 读不到、Node 也拿不到）。
所以**不在 Node 里发请求**，而是在**已登录的页面上下文里 `fetch`** —— 浏览器自动带上全部 Cookie：

```js
// 在 opencli browser <session> eval 里执行
const fd = new FormData();
fd.append('moment_id', '...');
fd.append('contents', '[...]');
await fetch('/webapiv2/moment-comment/v1/create?X-UA=' + encodeURIComponent(XUA), {
  method: 'POST',
  credentials: 'include',                       // ← 带 Cookie 的关键
  headers: { 'x-xsrf-token': XSRF,              // ← 从 document.cookie 读 XSRF-TOKEN
             'x-requested-with': 'XMLHttpRequest',
             'x-tap-webapp-next-runtime-env': 'release-gray' },
  body: fd,                                     // 不要手写 Content-Type，让 fetch 自己定 boundary
});
```

好处：**零凭据落盘**（不需要把 Cookie 存成文件/塞进 git），而且和真人操作同一条通道。

`X-UA` 里的 `UID`/`VID` 取 Cookie 的 `web_app_uuid` / `ACCOUNTS_USER_ID`：

```
V=1&PN=WebApp&LANG=zh_CN&VN_CODE=100000000&LOC=CN&PLT=PC&DS=Android&UID=<web_app_uuid>&OS=Windows&OSV=10&DT=PC&VID=<uid>
```

### 8.2 发回复

```
POST /webapiv2/moment-comment/v1/create?X-UA=<urlencoded>
form: moment_id=<19位字符串>
      contents=<JSON 字符串>
```

`contents` 是**富文本节点数组的 JSON 字符串**：

```json
[{"type":"paragraph","children":[{"text":"正文第一行"}]},
 {"type":"paragraph","children":[{"text":"「版主助手-小鲸鱼」"}]}]
```

⚠️ **换行必须靠多个 paragraph 节点**：一个节点里的 `\n` 在时间线上不换行（`buildContents()` 已按行拆分）。

楼中楼（回复某条评论）：`/moment-comment/v1/create-child`，多一个 `parent_post_id=<被回复的评论 id>`。

### 8.3 表情节点

文本里写 `[表情_开心]` 是**无效**的（只会变成纯文本）。要真表情必须发节点：

```json
{"type":"tap_emoji","children":[{"text":"[表情_开心]"}],"info":{"id":71,"url":"https://..."}}
```

`info.id` 只能从表情面板 DOM 里读（`<img data-tap-editor-emoji-id alt="开心">`），
所以先用 `node scripts/emoji-map.mjs` 采集一次 → 存 `data/emoji-map.json`（实测 61 个表情）。
表里没有的表情会被丢掉；带表情发送失败会自动退回纯文本重发。

### 8.4 移除（不是删帖）

```
POST /webapiv2/moment/v3/unlink-group?X-UA=<urlencoded>
form: id=<moment_id>
      group_id=<论坛 group_id，PVZ2 = 40173>
```

- 「论坛管理 → 移除」就是它：**只是解除与板块的关联**，帖子详情页仍可访问。
- 成功后**板块列表有几秒缓存**：紧接着查还能查到，等 2s 再查就没了 → 校验要重试一次，别急着判失败。
- 老帖校验别只翻前 3 页：要翻到**比目标帖发布时间更早**的帖子，才能确定它真的不在列表里（`feedHas({untilTs})`）。

### 8.5 错误语义

| 现象 | 含义 |
|---|---|
| `404` + `{"data":{"code":-1,"error":"not_found"}}` | 鉴权**已通过**，是业务对象不存在（拿假 id 探测连通性就看这个） |
| `200` + HTML（`aliyun_waf_aa`） | 被 WAF 拦了，退避重试 |
| 其它 4xx/5xx | 看 `data.msg` |

### 8.6 节奏

接口之间保持 **1s 间隔**（管理任务）；答疑/夸奖保持原有 6s 间隔。节流在 `makeTapApi({intervalMs})` 里做。
