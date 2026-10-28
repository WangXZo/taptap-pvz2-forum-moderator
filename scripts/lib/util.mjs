// 通用小工具：散列
//
// 为什么单独抽一个文件：
//   这两个散列函数原来在 4 个地方各抄一份（praise.mjs、variants.mjs、collect.mjs…），
//   算法一模一样但名字不同（hashOf / liteHash / hashTextLite）——
//   改一边忘另一边，就是「同一份答案在两个模块算出不同散列」的经典坑。
//   现在只有这一份实现，谁要谁 import。

/**
 * 稳定散列（31 进制，跨进程一致）
 * 用于「按某个字符串稳定地选一个模板/分支」—— 同一个输入永远得到同一个结果。
 */
export function stableHash(s) {
  let h = 0;
  for (const ch of String(s || '')) h = (h * 31 + ch.codePointAt(0)) % 100000007;
  return h;
}

/**
 * 轻量散列（djb2，输出十六进制）
 * 用于「快速判断一段文本是否已经发过」—— 存进 state.json 当 key 用。
 */
export function liteHash(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
