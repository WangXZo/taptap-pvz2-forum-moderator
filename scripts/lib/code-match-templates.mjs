// 天宫码撮合文案模板池（用户 2026-11-12 要求）
//
// 用户原话：「现在这套「4 选 1 + 按帖 id 散列」要扩。每次预生成使用后替换。
//            即 LLM 预生成模板，使用完即抛弃，模板减少就替换已使用的模板。补足模板数。
//            （建议：少于 4 模板，补足到 8 模板，每次 LLM 预生成模板）」
//
// 设计要点：
//   · 模板池存**独立文件** data/code-match-templates.json（watch 拥有）
//     —— 绝不写 state.json：state.json 由 collect 拥有，两边各写会互相覆盖（踩过）。
//   · **用一条少一条**（用完即弃）→ 同一条模板不会被发两次。
//   · 池里剩 < minTemplates(4) → 让 LLM 预生成，补到 targetTemplates(8)。
//   · 池空 / LLM 挂 → 退回内置兜底模板（不能因为生成失败就发不出撮合通知）。
//   · 模板带 createdAt，超过 maxAgeHours 作废 → 触发补足。
//     ⚠️ 为什么要有老化：一天只撮合 1~2 次时，池子 8 条只少 1~2 条，
//        剩下 7 条永远不会被替换 → 实际退化回「固定池」，跟原来的 4 选 1 没本质区别。
//        加老化后池子定期换新血，才真的「每次都是新的」。
//
// 质量闸（生成的模板要过四道筛，不合格的直接丢）：
//   ① 承诺/引流词（含换码承诺）　② 含真实网址　③ 长度异常　④ 与已有模板重复
//
// 纯函数为主（不联网的部分），LLM 生成那一段把 ask 做成可注入 → 便于回归测试。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chat } from './llm.mjs';
import { answerPromisesCode } from './code-guard.mjs';

/** 内置兜底模板（池空 / LLM 挂了时用；也是首次运行起池的种子） */
export const DEFAULT_TEMPLATES = [
  '小鲸鱼趁热赶紧把大佬最新的天宫码给你拿过来了，快去领，记得去谢谢大佬。{link}',
  '趁热！大佬刚发了新的天宫码，小鲸鱼给你端过来了，快去领，领完记得谢谢大佬。{link}',
  '有佬刚撒了个天宫码，小鲸鱼趁热给你拿来了，手快有手慢无，领到了记得去谢谢大佬。{link}',
  '大佬最新的天宫码，小鲸鱼趁热给你端来了，快去领，用完回帖谢谢人家一声。{link}',
];

/**
 * 硬禁词：承诺类 + 引流类
 * ⚠️ 只转达链接 —— 担保「能用」/承诺互换/引流私聊，全都越界。
 */
const FORBIDDEN_RE =
  /(保证|肯定能用|一定能用|必然能用|包过|必过|百分百|绝对有效|稳过|我给你|我这边有|我发你|我私你|帮你换|帮你找|帮你留|私信我|加我|绝对能)/;

/** 归一化（去掉占位符与标点）→ 用于去重比较 */
export function normalizeForCompare(t) {
  return String(t || '')
    .replace(/\{link\}/g, '')
    .replace(/[\s，,。.!！?？~～、:：;；「」『』"'（）()【】\[\]—\-]/g, '');
}

/**
 * 校验一条模板能不能用
 * @returns {{ok:boolean, reason?:string, text?:string}}
 */
export function validateTemplate(raw, { existing = [] } = {}) {
  let t = String(raw ?? '')
    .trim()
    .replace(/^["'“「『]|["'”」』]$/g, '')
    .trim();
  if (!t) return { ok: false, reason: '空' };
  if (/https?:\/\//i.test(t)) return { ok: false, reason: '含真实网址' };
  if (FORBIDDEN_RE.test(t)) return { ok: false, reason: '含承诺/引流词' };
  if (answerPromisesCode(t).promise) return { ok: false, reason: '含换码承诺' };
  if (!t.includes('{link}')) t = `${t}{link}`; // 没写占位符 → 补到句尾（容错）
  const body = t.replace(/\{link\}/g, '').trim();
  if (body.length < 10) return { ok: false, reason: '太短' };
  if (body.length > 80) return { ok: false, reason: '太长' };
  if (!/小鲸鱼/.test(t)) return { ok: false, reason: '缺人格自称「小鲸鱼」' };
  const key = normalizeForCompare(t);
  const have = new Set(existing.map((x) => normalizeForCompare(x)));
  if (have.has(key)) return { ok: false, reason: '重复' };
  return { ok: true, text: t };
}

/**
 * 从 LLM 回答里抠出模板数组
 * （模型爱加 ```json 围栏、前后带解释文字 → 都要能扛住）
 */
export function parseTemplateList(raw) {
  const s = String(raw || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  if (!s) return [];
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a >= 0 && b > a) {
    try {
      const arr = JSON.parse(s.slice(a, b + 1));
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string');
    } catch {
      /* 落到逐行兜底 */
    }
  }
  const out = [];
  for (const line of s.split(/\r?\n/)) {
    const m = line.match(/["'“]([^"'”]{8,})["'”]/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** 生成模板的提示词 */
export function buildTemplatePrompt(n) {
  return [
    `给「天宫码撮合通知」写 ${n} 条文案模板，要求：`,
    '',
    '【角色】你是 TapTap 植物大战僵尸2 论坛里的热心版主助手「小鲸鱼」，说话像真人。',
    '【内容】告诉对方：有大佬刚发了新的天宫码，帖子链接给你，快去领，领完记得谢谢大佬。',
    '【硬性要求】',
    '1. 每条都要有「{link}」占位符表示链接的位置（链接由脚本填，不要自己写网址）。',
    '2. 每条 15~45 字；语气轻快、有会话感，像在群里喊一嗓子；不要客服腔、不要油腻、不要连发感叹号。',
    '3. 每条都要自称「小鲸鱼」。',
    '4. 绝对不能出现：保证、肯定能用、一定能用、包过、必过、我给你、我这边有、帮你换、帮你找码、私信、加我。',
    '5. 只转达链接，不评价码能不能用、不承诺任何事。',
    '6. 不要写 [表情_xxx] 之类标记。',
    '7. 各条说法要明显不同，别只是换几个词。',
    '',
    `【输出】只输出一个 JSON 数组，${n} 个字符串元素，每个元素是一条模板。不要任何解释文字。`,
  ].join('\n');
}

/**
 * 让 LLM 预生成模板
 * @param {object} config
 * @param {number} o.count 要几条
 * @param {Function} [o.ask] 注入用的问法（测试用；默认走 lib/llm.mjs）
 * @returns {{ok:boolean, templates?:string[], reason?:string, rawCount?:number}}
 */
export async function generateTemplates(config, { count = 8, log = () => {}, ask = null } = {}) {
  if (count <= 0) return { ok: true, templates: [] };
  let text = '';
  if (ask) {
    const r = await ask({ system: '', user: buildTemplatePrompt(count) });
    if (!r?.ok) return { ok: false, reason: r?.reason || '生成失败', templates: [] };
    text = String(r.text || '');
  } else {
    const r = await chat(config, {
      system: '你是中文社区话术编辑，只输出用户要求的 JSON，不要解释。',
      messages: [{ role: 'user', content: buildTemplatePrompt(count) }],
      temperature: 0.9,
      maxTokens: 1400,
      timeoutMs: 60000,
      log,
    });
    if (!r.ok) return { ok: false, reason: r.error || '生成失败', templates: [] };
    text = String(r.text || '');
  }
  const raw = parseTemplateList(text);
  const out = [];
  const seen = [];
  for (const t of raw) {
    const v = validateTemplate(t, { existing: seen });
    if (!v.ok) continue;
    seen.push(v.text);
    out.push(v.text);
  }
  return { ok: true, templates: out, rawCount: raw.length };
}

/** 读池子（顺带丢掉过期的） */
export async function loadPool(file, { maxAgeHours = 24, nowMs = Date.now() } = {}) {
  let raw = null;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { templates: [], dropped: 0 };
  }
  let j = {};
  try {
    j = JSON.parse(raw);
  } catch {
    return { templates: [], dropped: 0 };
  }
  const arr = Array.isArray(j.templates) ? j.templates : [];
  const out = [];
  let dropped = 0;
  for (const item of arr) {
    const text = typeof item === 'string' ? item : item?.text;
    if (!text) continue;
    const created = typeof item === 'object' && item?.createdAt ? Date.parse(item.createdAt) : 0;
    if (created && maxAgeHours > 0 && nowMs - created > maxAgeHours * 3600 * 1000) {
      dropped++;
      continue;
    }
    out.push({
      text,
      createdAt: created ? new Date(created).toISOString() : new Date(nowMs).toISOString(),
    });
  }
  return { templates: out, dropped };
}

/** 存池子 */
export async function savePool(file, templates) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      { templates: templates.map((t) => ({ text: t.text, createdAt: t.createdAt })), updatedAt: new Date().toISOString() },
      null,
      1
    ),
    'utf8'
  );
}

/**
 * 取一条模板（**取走即从池里消失** —— 用完即弃）
 * @returns {{text:string, rest:Array}|null}
 */
export function takeTemplate(pool, { rng = Math.random } = {}) {
  if (!Array.isArray(pool) || !pool.length) return null;
  const i = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
  const item = pool[i];
  const rest = pool.slice(0, i).concat(pool.slice(i + 1));
  return { text: item.text, rest };
}

/** 把 {link} 占位符换成真实链接 */
export function renderTemplate(tpl, share) {
  const link = `https://www.taptap.cn/moment/${share?.id || ''}`;
  return String(tpl || '').replace(/\{link\}/g, link);
}
