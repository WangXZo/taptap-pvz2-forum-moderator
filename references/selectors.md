# 回复框选择器校准手册

官方没有回复接口，只能用 opencli 驱动真实 Chrome 点。**首次使用必须校准一次。**

## 校准流程（只读，不发送）

```bash
# 1) 打开一篇帖子
opencli browser tap open "https://www.taptap.cn/moment/<moment_id>"

# 2) 看页面结构，找出回复输入框
opencli browser tap state
opencli browser tap find --css "textarea"
opencli browser tap find --css "[contenteditable=true]"

# 3) 找发送按钮
opencli browser tap find --role button --name 发送
```

`state` 输出里带 `[N]` 数字引用，交互时优先用数字引用（比 CSS 选择器抗 DOM 变动）。

## 当前默认候选

`lib/replier.mjs` 里的候选顺序：

**输入框**

```
[contenteditable=true]      ← 实际命中（tiptap ProseMirror）
textarea[placeholder*="回复"]
textarea[placeholder*="说点什么"]
textarea
```

**工具栏（表情按钮是第 2 个）**

```
.tap-editor-toolbar-item__wrap      ← 第 2 个 = 表情，第 1 个 = @，第 3 个 = 图片
```

**发送按钮**

```
button（text === "发送"）
[class*=send]
[class*=submit]
```

**表情面板**

```
.tap-editor-emoji__popover                    面板容器
.tap-editor-emoji-lists__tab-header-tabs      分组 tab
img[data-tap-editor-emoji-id]                  表情项（alt = 中文名，data-tap-editor-emoji-id = id）
```

## 改法

校准完成后，把确认可用的选择器放到候选列表**最前面**即可，其余保持不动作为兜底。

## 发送失败怎么办

`replyOne()` 的失败分四档，脚本会分别标记：

| stage | 含义 | 处理 |
|---|---|---|
| `open` | 页面打不开 | 检查网络 / opencli session |
| `no_input` | 找不到输入框 | 重新校准选择器 |
| `fill` | 正文没写进去 | 看 detail.missing 判断缺哪段 |
| `emoji` | 表情没插上 | 看 detail.missed 的 reason |
| `no_send_button` | 找不到发送按钮 | **已中止，不会盲点** |

**任一失败都不会重试发送**（避免重复回帖），而是把该帖转成「🖐 需人工处理」。

## 安全提醒

- 先 `--dry-run` 跑，确认文案口径
- 第一次真发只发一条：`node scripts/reply.mjs --only <moment_id> --yes`
- 人工确认这条确实发出去了、格式没坏，再放开全量
