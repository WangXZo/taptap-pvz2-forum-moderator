# TapTap 游戏评价接口（review）实测手册

> 来源：2026-11-13 大哥提供的**两条真实 cURL**（浏览器「Copy as cURL」），
> 我逐条实测校准了参数、返回结构与错误语义。**不要凭猜**，参数报错照本表核对。
> 实现见 `scripts/lib/review.mjs`（纯函数）+ `scripts/lib/taptap-api.mjs`（四个动作）。

## 1. 端点总表

| 用途 | 路径 | 方法 | 认证 |
|---|---|---|---|
| **评价列表** | `/webapiv2/review/v2/list-by-app` | GET | **匿名可读**（实测 200） |
| 评价详情 | `/webapiv2/review/v2/detail` | GET | 匿名可读 |
| **回一条评价** | `/webapiv2/review-comment/v1/create` | POST (multipart) | 需登录 Cookie + `x-xsrf-token` |
| **读评价的全量回复** | `/webapiv2/review-comment/v1/by-review` | GET | 匿名可读 |

跟论坛接口（`feed/v7/by-group`、`moment-comment/v1/*`）是**同一套基建**：
`webapiv2` + `X-UA` query 参数 + 页面上下文 fetch → 所以 `taptap-api.mjs` 的 `get`/`post` 直接能用。

## 2. 评价列表（读）

```
GET /webapiv2/review/v2/list-by-app
    ?app_id=54031&limit=10&label=&mapping=&source_type=&sort=new
    &stage_type=&test_plan_id=&X-UA=<urlencoded>
```

| 参数 | 说明 |
|---|---|
| `app_id` | **必填**，游戏 id（PVZ2 = 54031）。跟论坛的 `group_id`(=40173) 是两回事 |
| `limit` | **上限 10**（同论坛口径） |
| `sort` | `new` = 按最新 |
| `label` / `mapping` / `source_type` / `stage_type` / `test_plan_id` | 留空即可 |

返回（实测）：

```jsonc
{
  "success": true,
  "data": {
    "list": [
      {
        "type": "moment",
        "identification": "moment:870292567579689482",
        "menu": { "options": [ /* 屏蔽 / 关注 / 投诉 等菜单 */ ] },
        "moment": {
          "id_str": "870292567579689482",
          "publish_time": 1794546717,
          "commented_time": 1794556863,
          "author": { "user": { "id": 802972706, "name": "兑勾打团来" } },
          "device": "PC 客户端",
          "review": {
            "id": 51123606,                    // ← 评价 id（回评论用这个）
            "score": 1,                        // 星级
            "played_spent": 11880,
            "total_played_spent": 11880,
            "stage": "publish",
            "stage_label": "",
            "source": "taptap",
            "contents": { "text": "我之前的号是OPPO渠道服的…", "raw_text": "…" },
            "review_comments": [ /* ⚠️ 只是预览子集，见 §5 */ ]
          }
        }
      }
    ],
    "total": 10000,
    "prev_page": null,
    "next_page": null,
    "has_collapsed_list": false
  }
}
```

## 3. 回一条评价（写）

```
POST /webapiv2/review-comment/v1/create?X-UA=<urlencoded>
Content-Type: multipart/form-data
头：x-xsrf-token=<取自 document.cookie>
form:
  review_id = 51123606
  contents  = <纯文本>
```

### ⚠️ `contents` 是**纯文本**，跟论坛回复不一样

| | 论坛回复 | 评价回复 |
|---|---|---|
| `contents` 格式 | 富文本节点数组的 JSON 字符串 `[{type:'paragraph',…}]` | **纯文本字符串** |
| 表情 | 支持 `tap_emoji` 节点 | **没验证过 → 一律剥掉** |
| 落库形态 | `contents.json`（节点数组） | `contents.text` + `contents.raw_text`（都是纯文本） |

真实 cURL 里 `contents` 就是 `taptap` 这样的裸字符串（`multipart/form-data` 里也不带引号）。

> ⚠️ `buildReviewContents()` 会把 `[表情_xx]` / `[TapTap×x_y]` 标记**剥掉**再发。
> 表情节点在评价接口没验证过 → 宁可不发，也别发出字面量 `[表情_开心]`。

### 签名

跟其它回复出口一致：**签名由脚本加一次**（`clampReply(text, {signature})`），
`reviewReply()` 内部也会兜一层（幂等 —— 已经带了就不重复加）。

## 4. 读某条评价的全量回复（读，**校验落库用**）

```
GET /webapiv2/review-comment/v1/by-review
    ?review_id=51123606&limit=10&from=0&order=desc&X-UA=<urlencoded>
```

| 参数 | 说明 |
|---|---|
| `review_id` | **必填**（漏了报 `「review_id」必填`） |
| `limit` | **上限 10**（实测 15 / 20 都 400：`Field validation for 'limit' failed on the 'max' tag`） |
| `from` | offset |
| `order` | **必填**，只能是 `asc` \| `desc`（漏了报 `Field validation for 'order' failed on the 'oneof' tag`） |

返回：

```jsonc
{
  "success": true,
  "data": {
    "list": [
      {
        "id": 36692150,
        "contents": { "text": "还不如用taptap方便是吧！", "raw_text": "…" },
        "ups": 0, "downs": 0,
        "created_time": 1794556863,
        "is_official": false,       // 官方回复标记
        "collapsed": false,
        "author": { "id": 63****64, "name": "枫之****Zo" },
        "complaint": { "web_url": "/complaint?id=36692150&type=review_comment" },
        "actions": { "update": true, "delete": true, "comment": true }
      }
    ],
    "total": 2,
    "show_all": false,
    "prev_page": null,
    "next_page": null
  }
}
```

`order=desc` = **新→旧**（我们刚发的那条一定排最前，校验最稳）；`asc` = 旧→新。

## 5. ⚠️ 列表里的 `review_comments` 是**预览子集**，不能拿来校验

实测对照（review 51123606）：

| 来源 | 条数 |
|---|---|
| 列表接口的 `moment.review.review_comments` | **1** 条（只有官方回复） |
| `by-review` 全量 | **2** 条（官方回复 + 我们自己发的那条） |

→ **校验「回复有没有落库」必须走 `by-review`**，否则会误判成「没发出去」。

## 6. ⚠️ 详情接口 `data.review` 是**空壳**

```
GET /webapiv2/review/v2/detail?id=51123606
```

- `data.review` → 对象存在但**字段全是 undefined**（`review.keys` 是空字符串）
- 真正的 review 在 **`data.moment.review`**

`normalizeReview()` 两个位置都认，所以传哪种都行。

## 7. 四个动作怎么用

```js
import { getTapApi } from './lib/taptap-api.mjs';

const api = getTapApi({ runner, log });

// 列评价（app_id 不写死，从 config 传）
const list = await api.reviewList({ appId: config.appId, limit: 10, sort: 'new' });
// → { ok, list:[{reviewId, score, text, authorId, authorName, url, …}], total }

// 回一条评价（contents 自动是纯文本 + 带签名）
const sent = await api.reviewReply({
  reviewId: '51123606',
  text: '换渠道的话旧号要登回旧包体才能用',
  signature: config.reply.signature,
});
// → { ok, status, contents:'换渠道的话旧号要登回旧包体 「版主助手-小鲸鱼」' }

// 校验落库（读 by-review，按纯文本包含匹配）
const v = await api.hasReviewReplyText({ reviewId: '51123606', text: sent.contents });
// → { found:true, id:36692150, total:2 }
```

## 8. 与论坛接口的差异对照（最容易踩的地方）

| 维度 | 论坛 | 评价 |
|---|---|---|
| 作用域 id | `group_id` = 40173 | `app_id` = 54031 |
| 读评论端点 | `/moment-comment/v1/by-moment` | `/review-comment/v1/by-review` |
| 读评论必填参数 | `moment_id` | `review_id` + **`order`** |
| 读评论 limit 上限 | 30 | **10** |
| `contents` 格式 | 富文本 JSON | **纯文本** |
| 表情 | `tap_emoji` 节点 | 未验证 → 剥掉 |
| 列表里的评论是否全量 | 基本全量 | **只是预览子集** |

## 9. 验证记录（2026-11-13）

| # | 验证项 | 方法 | 结果 |
|---|---|---|---|
| 1 | 列表端点可用 | 原样复刻 cURL 打一次 | 200 / `success:true` / 10 条 / `total=10000` |
| 2 | 列表**不需要 Cookie** | 裸 fetch（无 cookie/xsrf） | 200 正常返回 → 公开接口 |
| 3 | 回复端点参数正确 | **无损**：读回大哥手动发的那条 | comment `36692150`、作者 `63****64`、正文与手发一致 → `review_id` + `contents` + xsrf 正确 |
| 4 | 读全量回复端点 | `by-review` 试参数 | `order=asc/desc` 合法；`order` 必填；`limit` 上限 10 |
| 5 | `contents` 是纯文本 | 看落库对象 | `{text, raw_text}`，**不是**节点数组 |
| 6 | 列表评论是子集 | 列表 1 条 vs by-review 2 条 | 确认必须用 by-review 校验 |
| 7 | 详情空壳 | `review/v2/detail` | `data.review` 空、`data.moment.review` 才有数据 |

> 验证全程**只读**，没有额外发过任何回复；第 3 项是「读回校验」，不产生新数据。

## 10. 单测

```bash
node scripts/test-review-api.mjs   # 74 条断言：端点常量/参数规范化/纯文本载荷/摊平/落库校验/失败路径
```
