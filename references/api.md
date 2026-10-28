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
| **发回复** | `/creation/comment/v1/create` | POST (UrlEncoded) | 需登录 |
| 回复楼中楼 | `/creation/comment/v1/create-child` | POST (UrlEncoded) | 需登录 |
| 删除回复 | `/creation/comment/v1/delete` | POST | 需登录 |

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
