// 三层树状上下文（2026-11-04 用户要求）
//
// 原话：「每个帖子的，内容与关联度，是 3 层树状结构（帖子本身、回复、楼中楼回复），
//        即：其结构对父级结构关联较高，所有发言需要关注其所有父级内容作为上下文，
//        补充例外注意的是楼中楼回复 @XXX（对应玩家）需额外补充关注所在子叶平级
//        对应 @XXX 玩家的所有发言关联较高。」
//
// 建树：
//   第 0 层 = 帖子本身（标题 + 正文）
//   第 1 层 = 一级回复
//   第 2 层 = 楼中楼回复
//
// 取上下文（contextForNode）：
//   ① **父链**：目标节点 → 它的父 → 父的父 … → 帖子（关联度最高的那条线）
//   ② **@ 平级扩展**：如果目标节点（或同层兄弟）@ 了某个玩家，
//      就把**同一层里那个玩家说过的所有话**也带上（用户明确点名要的例外规则）
//
// 为什么这两条就够：Taptap 的楼层就这么三层，再往下的「谁回谁」只会变成@，
// 而@已经由第②条覆盖。不用爬全树，省 token 也省得把无关闲聊喂给模型。

const MAX_NODES = 400; // 防御：一栋楼几千条评论时别把内存和 token 打爆

/** 平坦文本（去多余空白，截断） */
function tidy(s, n = 400) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

/**
 * 建三层树
 * @param {object} post     { id, title, text, author, authorId }
 * @param {Array}  comments listComments 的 .list（每条可能带 child_posts）
 * @returns {{post:object, nodes:Map, roots:string[], byParent:Map}}
 */
export function buildThreadTree(post = {}, comments = []) {
  const nodes = new Map();
  const byParent = new Map();
  const roots = [];

  const postNode = {
    id: `post:${post.id || ''}`,
    level: 0,
    kind: 'post',
    author: post.author || '',
    authorId: String(post.authorId || post.author_id || ''),
    title: tidy(post.title, 120),
    text: tidy(post.text, 1200),
    parentId: null,
    children: [],
  };
  nodes.set(postNode.id, postNode);

  const addNode = (cm, level, parentId) => {
    if (nodes.size >= MAX_NODES) return null;
    const id = String(cm.id_str || cm.id || '');
    if (!id) return null;
    const node = {
      id,
      level,
      kind: level === 1 ? 'reply' : 'nested',
      author: cm.author?.name || '',
      authorId: String(cm.author?.id || ''),
      text: tidy(cm.__text || cm.text || '', 600),
      parentId,
      children: [],
      time: Number(cm.created_time || 0),
    };
    nodes.set(id, node);
    const p = parentId || postNode.id;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(id);
    if (level === 1) roots.push(id);
    const parent = nodes.get(parentId || postNode.id);
    if (parent) parent.children.push(id);
    return node;
  };

  for (const cm of comments || []) {
    const n1 = addNode(cm, 1, postNode.id);
    if (!n1) break;
    for (const ch of cm.child_posts || []) {
      addNode(ch, 2, n1.id);
    }
  }

  return { post: postNode, nodes, roots, byParent };
}

/** 文本里 @ 到了这栋楼里的谁（用已知昵称去比，避免把普通 @ 当成人名） */
export function findMentions(text, tree) {
  const t = String(text || '');
  if (!t.includes('@') && !t.includes('＠')) return [];
  const names = new Set();
  for (const n of tree.nodes.values()) {
    if (n.kind !== 'post' && n.author) names.add(n.author);
  }
  const hits = [];
  for (const name of names) {
    if (!name) continue;
    // @名字 后面可能紧跟空白/标点
    const re = new RegExp(`[@＠]\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    if (re.test(t)) hits.push(name);
  }
  // 兜底：@后面直接跟一串非空白字符，且这串正好是楼里某人的昵称前缀
  if (!hits.length) {
    for (const m of t.matchAll(/[@＠]\s*([^\s@＠，,。!?！？:：]{1,20})/g)) {
      const raw = m[1];
      for (const name of names) {
        if (name && (raw === name || name.startsWith(raw) || raw.startsWith(name))) hits.push(name);
      }
    }
  }
  return [...new Set(hits)];
}

/**
 * 取某个节点的上下文
 *
 * @param {object} tree    buildThreadTree 的结果
 * @param {string} nodeId  要回复/要处理的那个节点（帖子本身传 `post:<id>`
 * @param {object} [opt]
 * @param {boolean} [opt.expandMentions=true] 是否做 @ 平级扩展
 * @returns {{target:object, chain:Array, mentioned:Array, level:number}}
 */
export function contextForNode(tree, nodeId, { expandMentions = true } = {}) {
  const target = tree.nodes.get(String(nodeId)) || tree.post;
  if (!target) return { target: null, chain: [], mentioned: [], level: -1 };

  // ① 父链：从目标往上走到帖子（倒过来输出，帖子在前）
  const chain = [];
  let cur = target;
  const guard = new Set();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? tree.nodes.get(cur.parentId) : null;
  }
  chain.reverse();

  // ② @ 平级扩展：目标节点 @ 了谁 → 把**同一层**那个玩家的话也带上
  const mentioned = [];
  if (expandMentions && target.level >= 1) {
    const names = findMentions(target.text, tree);
    const siblings = (tree.byParent.get(target.parentId) || [])
      .map((id) => tree.nodes.get(id))
      .filter((n) => n && n.id !== target.id && n.level === target.level);
    for (const name of names) {
      const said = [];
      // 同层里那个玩家的发言
      for (const s of siblings) {
        if (s.author === name && s.text) said.push({ where: `同层#${s.id}`, text: s.text });
      }
      // 他在这条父链更上层说过的话也带上（关联度高）
      for (const c of chain) {
        if (c.author === name && c.text && !said.some((x) => x.text === c.text)) {
          said.push({ where: c.level === 0 ? '帖子正文' : `L${c.level}#${c.id}`, text: c.text });
        }
      }
      if (said.length) mentioned.push({ author: name, said });
    }
  }

  return { target, chain, mentioned, level: target.level };
}

/**
 * 把上下文渲染成给模型看的紧凑文本
 * @returns {string}
 */
export function renderContext(ctx, { maxChars = 3000 } = {}) {
  if (!ctx || !ctx.target) return '';
  const out = [];
  for (const n of ctx.chain) {
    if (n.level === 0) {
      out.push(`【帖子】标题：${n.title || '(无)'}`);
      if (n.text) out.push(`正文：${n.text}`);
      if (n.author) out.push(`楼主：${n.author}`);
    } else {
      const tag = n.level === 1 ? '回复' : '楼中楼';
      out.push(`【${tag}#${n.id}】${n.author}：${n.text}`);
    }
  }
  if (ctx.mentioned?.length) {
    for (const m of ctx.mentioned) {
      out.push(`【同层上下文】${m.author} 在这楼说过的：`);
      for (const s of m.said.slice(0, 5)) out.push(`  - （${s.where}）${s.text}`);
    }
  }
  let text = out.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（后面省略）';
  return text;
}
