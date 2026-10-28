# GitHub 调研：有没有能直接帮上忙的项目

> 调研时间：2026-10-26　检索方式：GitHub Topics、GitHub Search API、仓库文件树核查
> 结论：**没有一个「直接能用」的**，但有两个仓库值得抄作业，其余是组件级参考。

---

## 结论先行

| 项目 | 相关度 | 能拿来干什么 |
|---|---|---|
| [hccccc01333/taptap-hotspot-intel](https://github.com/hccccc01333/taptap-hotspot-intel) | ★★★★★ | **TapTap 社区采集器源码可直接抄**，接口和我实测的完全一致 |
| [QIUZAIYOU/Taptap-PostPreview](https://github.com/QIUZAIYOU/Taptap-PostPreview) | ★★★☆☆ | 论坛页 DOM 结构参考，油猴脚本，轻量 |
| [Eben001/nairaland_autorepy_bot](https://github.com/Eben001/nairaland_autorepy_bot) | ★★★☆☆ | Playwright + LLM 自动回帖的**流程范本** |
| [neonwatty/playwright-profiles](https://github.com/neonwatty/playwright-profiles) | ★★★☆☆ | 登录态 profile 管理（如果你不用 opencli 而走 Playwright） |
| [zhimaAi/chatwiki](https://github.com/zhimaAi/chatwiki) | ★★☆☆☆ | 开源 RAG 客服，**偏重**，QA 库做大后的参考 |
| [taptap/instant-games-open-mcp](https://github.com/taptap/instant-games-open-mcp) | ★☆☆☆☆ | 官方 MCP，但管的是小游戏开发，跟你无关 |

---

## 逐个点评

### 1. taptap-hotspot-intel（最值得看）

`L1_data_source/collectors/taptap/crawl_taptap_community.py`（54 KB，Python）是**完整可用的 TapTap 社区采集器**。

我核对了它用的接口，和我实测的一致：

```
/webapiv2/feed/v7/by-group            ← 帖子流（我用的就是这个）
/webapiv2/moment-comment/v1/by-moment ← 回复列表（我用的就是这个）
/webapiv2/group/v1/list               ← 社区地图
/webapiv2/groups/game                 ← 游戏分组枚举
```

它还实现了：S1 社区地图（2357 个社区索引）、S2 帖子流 thread 发现 + 计数快照、S3 评论全量首抓 + 增量补齐、`parent_id` 贯通（楼中楼）。凭据走环境变量 `TAPTAP_X_UA` / `TAPTAP_COOKIE`。

**你可以怎么用**：如果我写的 Node 版哪天接口变了，直接照它的 Python 实现改参数即可；它的「增量补齐」和「计数快照爆火检测」思路也可搬过来。

**不建议整体用**：它是六层「增长情报 OS」，带 FastAPI + React + Playwright + OCR，为「趋势分析」设计，不是为「答疑回复」设计。杀鸡用牛刀。

### 2. Taptap-PostPreview

油猴/Violentmonkey 用户脚本，在 TapTap 论坛列表页给帖子卡片加「预览」按钮。纯前端 DOM 操作。

**价值**：如果你想不装整套系统、只在浏览器里轻度增强，这类脚本的思路（注入按钮 + 读卡片数据）很轻。也侧面说明 TapTap 论坛页的 DOM 是可稳定操作的。

### 3. nairaland_autorepy_bot

Playwright + Gemini，自动浏览论坛、生成回复、发出去。

**价值**：它验证了「Playwright 驱动已登录会话 + LLM 生成回复 + 自动提交」这条链路在论坛场景是可行的，流程划分（发现→筛选→生成→提交→记录）和我这套四层结构一致。可以对照它的错误处理和限流写法。

### 4. playwright-profiles

Claude Code 插件，管理 Playwright 的登录 profile（`node ~/.playwright-cli/sign-in.mjs login <站点>`）。

**价值**：如果你以后不想依赖 opencli 浏览器扩展，改用 Playwright 独立 profile，这个能省掉登录态持久化的活。**当前不需要**——你的 Chrome 已经登录，opencli 直接复用更省事。

### 5. chatwiki

开源 RAG 知识库 + AI 客服，支持 20+ 模型，Docker 部署。

**价值**：等你的 QA 库涨到几百条、关键词匹配不够用时，可以参考它怎么组织「知识库 → 检索 → 生成」。
**不建议现在上**：要 Linux 服务器 + Docker，为一个答疑组的日常需求太重。

### 6. taptap/instant-games-open-mcp

TapTap 官方的 MCP 服务，但面向「小游戏开发 + TapTap Maker 客户端」，跟社区运营/答疑无关。列在这里只是说明「官方开源里没有社区管理能力」。

---

## 顺手记下的其他线索

- GitHub `taptap` topic 下共 24 个仓库，除上述外基本是「TapTap PC SDK 绑定」「Phigros 相关」「小游戏引擎」等，与答疑无关。
- GitHub Search API 搜 `taptap scraper`、`taptap 论坛 自动回复` 均返回 **0 结果**——说明这个细分场景没人做过开源项目，你得自己攒，这符合预期。

---

## 所以结论是

**没有现成的「PVZ2 答疑机器人」可以 clone 下来直接用。** 但 `taptap-hotspot-intel` 的采集层证明了我逆向出的接口是对的，也给了接口变更时的替代实现；`nairaland_autorepy_bot` 给了自动回帖的流程范本。这两条足够支撑自建。
