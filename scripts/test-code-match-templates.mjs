#!/usr/bin/env node
// 回归测试：天宫码撮合文案模板池（用户 2026-11-12）
//
// 覆盖：
//   ① 质量闸：承诺词 / 真实网址 / 长度 / 缺占位符 / 缺人格自称 / 重复
//   ② 解析：标准 JSON 数组、带 ```json 围栏、夹带解释文字
//   ③ 取用即弃：取一条少一条；池空返回 null
//   ④ 渲染：{link} 占位符替换成真实链接
//   ⑤ 老化：超过 maxAgeHours 的模板作废
//   ⑥ 预生成：过滤不合格 + 去重（注入假 ask，不联网）
import {
  DEFAULT_TEMPLATES,
  validateTemplate,
  parseTemplateList,
  generateTemplates,
  takeTemplate,
  renderTemplate,
  loadPool,
  savePool,
  normalizeForCompare,
} from './lib/code-match-templates.mjs';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`); }
};

console.log('=== ① 质量闸 ===');
{
  const ok = validateTemplate('小鲸鱼趁热把大佬的天宫码端来了，快去领，记得谢谢大佬。{link}');
  check('合格模板 → 通过', ok.ok === true, ok.reason);
  check('合格模板保留 {link}', ok.ok && ok.text.includes('{link}'));

  const noPh = validateTemplate('小鲸鱼趁热把大佬的天宫码端来了，快去领。');
  check('没写 {link} → 自动补到句尾', noPh.ok && noPh.text.endsWith('{link}'), noPh.reason);

  check(
    '含承诺词（保证能用）→ 拒',
    validateTemplate('小鲸鱼保证这个码一定能用，快去领。{link}').ok === false
  );
  check(
    '含承诺词（我给你）→ 拒',
    validateTemplate('小鲸鱼我给你一个码，快去领。{link}').ok === false
  );
  check(
    '含真实网址 → 拒',
    validateTemplate('小鲸鱼把码端来了 https://www.taptap.cn/moment/123 快去领。{link}').ok === false
  );
  check('太短 → 拒', validateTemplate('小鲸鱼{link}').ok === false);
  check(
    '太长 → 拒',
    validateTemplate('小鲸鱼' + '啊'.repeat(90) + '{link}').ok === false
  );
  check(
    '缺人格自称 → 拒',
    validateTemplate('有大佬发了新的天宫码，快去领，记得谢谢人家。{link}').ok === false
  );
  check(
    '重复（与已有相同）→ 拒',
    validateTemplate('小鲸鱼趁热赶紧把大佬最新的天宫码给你拿过来了，快去领，记得去谢谢大佬。{link}', {
      existing: ['小鲸鱼趁热赶紧把大佬最新的天宫码给你拿过来了，快去领，记得去谢谢大佬。{link}'],
    }).ok === false
  );
}

console.log('\n=== ② 解析 ===');
{
  check('标准 JSON 数组', parseTemplateList('["a模板内容甲","b模板内容乙"]').length === 2);
  const fenced = parseTemplateList('```json\n["a模板内容甲","b模板内容乙"]\n```');
  check('带 ```json 围栏', fenced.length === 2, JSON.stringify(fenced));
  const noisy = parseTemplateList('好的，这是模板：\n["a模板内容甲","b模板内容乙"]\n希望有帮助');
  check('夹带解释文字', noisy.length === 2, JSON.stringify(noisy));
  check('空输入 → 空数组', parseTemplateList('').length === 0);
  check('非数组 → 兜底逐行', parseTemplateList('"一行模板内容甲乙丙丁戊"').length === 1);
}

console.log('\n=== ③ 取用即弃 ===');
{
  const pool = [
    { text: 'T1', createdAt: 'x' },
    { text: 'T2', createdAt: 'x' },
    { text: 'T3', createdAt: 'x' },
  ];
  const t = takeTemplate(pool, { rng: () => 0 });
  check('取得到一条', t && t.text === 'T1', JSON.stringify(t));
  check('取走即从池里消失（用完即弃）', t && t.rest.length === 2);
  check('池里不再有取走的那条', t && !t.rest.some((x) => x.text === 'T1'));
  check('池空 → 返回 null', takeTemplate([]) === null);
}

console.log('\n=== ④ 渲染 ===');
{
  check(
    '{link} 换成真实链接',
    renderTemplate('小鲸鱼给你端来了{link}', { id: 'S9' }) ===
      '小鲸鱼给你端来了https://www.taptap.cn/moment/S9'
  );
}

console.log('\n=== ⑤ 老化 ===');
{
  const dir = resolve(tmpdir(), 'cmt-test-' + Date.now());
  const file = resolve(dir, 'pool.json');
  await mkdir(dir, { recursive: true });
  const now = Date.now();
  await writeFile(
    file,
    JSON.stringify({
      templates: [
        { text: '新模板{link}', createdAt: new Date(now - 60 * 1000).toISOString() },
        { text: '旧模板{link}', createdAt: new Date(now - 30 * 3600 * 1000).toISOString() },
      ],
    }),
    'utf8'
  );
  const pool = await loadPool(file, { maxAgeHours: 24, nowMs: now });
  check('过期的被丢掉', pool.templates.length === 1 && pool.templates[0].text === '新模板{link}', JSON.stringify(pool));
  check('过期计数有记录', pool.dropped === 1, String(pool.dropped));
  const none = await loadPool(resolve(dir, '不存在.json'), {});
  check('文件不存在 → 空池', none.templates.length === 0);
  await rm(dir, { recursive: true, force: true });
}

console.log('\n=== ⑥ 预生成（注入假 ask，不联网）===');
{
  const fake = async () => ({
    ok: true,
    text: JSON.stringify([
      '小鲸鱼趁热把大佬的天宫码端过来了，快去领，记得谢谢大佬。{link}',
      '小鲸鱼保证这个码一定能用，快去领。{link}', // 承诺词 → 应被过滤
      '小鲸鱼把码端来了 https://x.cn/1 快去领。{link}', // 真实网址 → 应被过滤
      '小鲸鱼趁热把大佬的天宫码端过来了，快去领，记得谢谢大佬。{link}', // 重复 → 应被过滤
      '大佬刚发了新码，小鲸鱼给你端来了，手快有手慢无。{link}',
    ]),
  });
  const gen = await generateTemplates({}, { count: 5, ask: fake });
  check('生成成功', gen.ok === true);
  check('原始 5 条 → 过滤后只剩 2 条', gen.templates.length === 2, JSON.stringify(gen.templates));
  check('承诺词那条被过滤', !gen.templates.some((t) => t.includes('保证')));
  check('含网址那条被过滤', !gen.templates.some((t) => /https?:\/\//.test(t)));
  const fail = await generateTemplates({}, { count: 5, ask: async () => ({ ok: false, reason: '挂了' }) });
  check('LLM 失败 → ok:false + 原因', fail.ok === false && fail.reason === '挂了');
}

console.log('\n=== ⑦ 内置兜底模板 ===');
{
  check('兜底模板至少 4 条', DEFAULT_TEMPLATES.length >= 4);
  check('兜底模板都带 {link}', DEFAULT_TEMPLATES.every((t) => t.includes('{link}')));
  check(
    '兜底模板都过质量闸',
    DEFAULT_TEMPLATES.every((t) => validateTemplate(t).ok),
    DEFAULT_TEMPLATES.filter((t) => !validateTemplate(t).ok).map((t) => validateTemplate(t).reason).join(',')
  );
  check(
    '兜底模板互不重复',
    new Set(DEFAULT_TEMPLATES.map(normalizeForCompare)).size === DEFAULT_TEMPLATES.length
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
