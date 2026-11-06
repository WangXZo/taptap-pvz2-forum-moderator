// 回复护栏（2026-11-04 精简后只剩这一件事）
//
// 背景：这一文件原来有 9 个语义桶、160+ 条模板文案、表情表、答疑库作答逻辑。
// 用户 2026-11-04 明确要求：
//   「模板仅作为参考资料，不要使用了，固定结构组合也不行，不要用了」
//   → 模板全部废弃，回复改由 LLM 按三层上下文生成（见 lib/compose-reply.mjs）
//
// 所以这里**只留硬护栏**：生成出来的话必须过这两道才准发。
//   ① assertKind  —— 不许贬低玩家、不许替官方承诺
//   ② assertNoLeak（在 lib/variants.mjs）—— 不许泄露内部机制
//
// ⚠️ 护栏是**最后一道**，不能因为换了生成方式就放松：LLM 也会说错话。

/** 可能贬低/嘲讽玩家的词（用户明确不允许） */
const BELITTLE_RE =
  /(傻|蠢|笨|弱智|脑残|废物|垃圾|滚蛋|滚开|闭嘴|菜鸡|丢人|活该|自己笨|别问了|懒得理|不关我事|爱信不信|无所谓了|自己去查|你懂什么)/;

/** 不能替官方承诺/表态（我们不是官方，承诺了会出事） */
const OVERPROMISE_RE =
  /(保证|肯定修|一定修|马上修|会补偿|给补偿|内部消息|官方说了|我们官方|包过|百分百|一定赔)/;

/**
 * 检查一段话能不能发出去
 * @param {string} text
 * @returns {{ok:boolean, hit?:string}}
 */
export function assertKind(text) {
  const t = String(text || '');
  if (!t.trim()) return { ok: false, hit: '空文案' };
  let m = t.match(BELITTLE_RE);
  if (m) return { ok: false, hit: `贬低用词「${m[0]}」` };
  m = t.match(OVERPROMISE_RE);
  if (m) return { ok: false, hit: `越权承诺「${m[0]}」` };
  return { ok: true };
}
