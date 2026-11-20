// O8 文档链接测试（2026-11-19）：SKILL.md / references 里的相对链接必须真实存在。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['SKILL.md'];
for (const f of readdirSync(resolve(ROOT, 'references'))) if (f.endsWith('.md')) files.push('references/' + f);
if (existsSync(resolve(ROOT, 'README.md'))) files.push('README.md');

let broken = 0;
for (const rel of files) {
  const abs = resolve(ROOT, rel);
  const text = readFileSync(abs, 'utf8');
  // 只查 markdown 相对链接（排除 http/https/mailto/锚点）
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = m[1].split('#')[0].trim();
    if (!target || /^(https?:|mailto:|\/\/)/.test(target)) continue;
    const p = resolve(dirname(abs), target);
    if (!existsSync(p)) { broken++; console.log(`  ✗ 死链 ${rel} → ${target}`); }
  }
}
t('无死链', broken === 0, `${broken} 个`);

console.log('\n== SKILL.md 精简性与必备内容 ==');
{
  const s = readFileSync(resolve(ROOT, 'SKILL.md'), 'utf8');
  const lines = s.split('\n').length;
  t('SKILL.md ≤ 300 行（实际 ' + lines + '）', lines <= 300);
  t('保留 frontmatter name', /^---[\s\S]*name:\s*taptap-pvz2-forum-moderator/.test(s));
  t('保留 frontmatter description', /description:\s*植物大战僵尸2/.test(s));
  t('指向完整手册', s.includes('references/skill-full.md'));
  t('含快速开始', s.includes('快速开始'));
  t('含四类标记', s.includes('四类标记') || s.includes('未回复待回复'));
  t('含铁律', s.includes('铁律'));
  t('含核心行为速查', s.includes('核心行为速查'));
  t('声明删评归人工', s.includes('删评归人工'));
  t('声明签名只由脚本加', s.includes('只由脚本追加'));
  t('提及评测/治理能力', s.includes('评测候选') || s.includes('自治治理'));
}

console.log('\n== 完整手册不丢内容 ==');
{
  const full = readFileSync(resolve(ROOT, 'references/skill-full.md'), 'utf8');
  const heads = (full.match(/^##\s/gm) || []).length;
  t('skill-full.md 章节数 ≥ 30（实际 ' + heads + '）', heads >= 30);
  t('原文关键章节在（排障）', full.includes('排障'));
  t('原文关键章节在（硬约束）', full.includes('硬约束'));
  t('原文关键章节在（答疑库格式）', full.includes('答疑库格式'));
  t('原 frontmatter 已剥离但正文保留', !full.startsWith('---\nname:'));
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);