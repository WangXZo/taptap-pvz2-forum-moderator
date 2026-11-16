// 纯文本小工具（无副作用、可单测）
//
// ⚠️ 2026-11-13 从 `taptap-api.mjs` 拆出来：
//   `taptap-api.mjs` 要 import 评价模块（review.mjs），
//   而 review.mjs 又需要 `stripEmojiMarks` → 直接互相 import 会形成**循环依赖**。
//   把这类「谁都要用」的小工具单独放一层，依赖就变成单向的：
//     text.mjs  ← taptap-api.mjs ← （外部）
//     text.mjs  ← review.mjs     ← taptap-api.mjs
//   `taptap-api.mjs` 仍 re-export `stripEmojiMarks`，老引用（replier / reply-nested /
//   test-api-contents）**不用改**。

/**
 * 去掉文案里的表情标记
 *
 * 两种标记：
 *   `[表情_开心]`      —— skill 自己用的写法
 *   `[TapTap×某某_开心]` —— 平台原生写法
 *
 * ⚠️ 只在「接口纯文本回复」时用：TapTap 富文本接口（论坛回复）能把表情标记
 *    转成 `tap_emoji` 节点，**不要**剥；评价回复接口只吃纯文本，**必须**剥
 *    （表情节点在评价接口没验证过，剥掉最保险）。
 */
export function stripEmojiMarks(text) {
  return String(text ?? '').replace(/\[(?:表情_[^\]]+|TapTap×[^\]_]+_[^\]]+)\]/g, '');
}
