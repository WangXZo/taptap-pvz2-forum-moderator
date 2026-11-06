// 泄露自检（2026-11-04 精简）
//
// 原来这里还有「6 种开头 × 4 种收尾」的变体组合、分享帖文案池、婉拒文案池。
// 用户 2026-11-04 明确要求：**模板不要用了**（回复改由 LLM 按三层上下文生成）。
//
// 这里**只留泄露自检** —— 生成的话里不能出现内部机制。
// ⚠️ 护栏是最后一道，换了生成方式也不能放松：LLM 同样会把后台说漏。

/** 内部机制相关词：出现就说明把「后台」说给玩家听了 */
const LEAK_PATTERNS = [
  /答疑库|资料库|知识库/,
  /state\.json|config\.json|qa-usage|\.mjs|\.json\b/,
  /scripts\/|references\/|assets\/|data\//,
  /opencli|selenium|playwright|puppeteer|CDP|调试模式/,
  /机器人|AI\s*助手|自动化脚本|爬虫|抓取接口|webapiv2/,
  /API\s*限流|WAF|阿里云/i,
  /prompt|system\s*prompt|api\s*key|token|cookie/i,
];

/**
 * 泄露自检：命中任一模式就判定为「不该发出去」
 * @returns {{ok:boolean, hit?:string}}
 */
export function assertNoLeak(text) {
  const t = String(text || '');
  for (const re of LEAK_PATTERNS) {
    const m = t.match(re);
    if (m) return { ok: false, hit: m[0] };
  }
  return { ok: true };
}
