// C5 意图/改写离线测试（P1，2026-11-17）
import { intentOf, rewriteQuery } from './lib/intent.mjs';
import { openDb } from './lib/db.mjs';
import { initFacts, addFact } from './lib/facts.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
let pass = 0, fail = 0;
const t = (n, c, x = '') => (c ? pass++ : (fail++, console.log(`  ✗ ${n} ${x}`)));
console.log('\n== intentOf ==');
t('求码 → code', intentOf({ title: '蹲一个天宫码', text: '' }) === 'code');
t('加好友 → code', intentOf({ title: '加好友扩列', text: '' }) === 'code');
t('抽到炫耀 → celebrate', intentOf({ title: '终于有了瓷砖萝卜', text: '' }) === 'celebrate');
t('imageCelebrate → celebrate', intentOf({ title: '神', text: '', imageCelebrate: true }) === 'celebrate');
t('提问 → qa', intentOf({ title: '困难6怎么过', text: '用什么植物' }) === 'qa');
// 回归（P3 检查发现）：问句里的「十连」是问规则，不算庆祝
t('问句十连 → qa 非 celebrate', intentOf({ title: '688是单抽还是十连', text: '' }) === 'qa');
t('晒十连出货 → celebrate', intentOf({ title: '十连出了瓷砖萝卜', text: '' }) === 'celebrate');
// 回归（P3 eval 基线发现）：求攻略含「攻略」被 NOT_ASK 判非提问 → intent 仍 qa；非游戏非问句 → chat
t('求攻略 → qa', intentOf({ title: '困难6怎么过', text: '困难6卡关了求攻略' }) === 'qa');
t('非游戏闲聊 → chat', intentOf({ title: '今天天气不错', text: '适合晒被子' }) === 'chat');
t('情绪帖不被 chat 抢', intentOf({ title: '我无疑是绝望的。。。', text: '任务差一点没完成' }) === 'comfort');
t('图片实体 → qa（C8）', intentOf({ title: '看图', text: '这是啥', imageEntities: ['688'] }) === 'qa');
// B4-8 回归：带疑问语气的不能被判 share（实测「批量兑换吗」曾被判 share → 漏答）
t('问句不被 share 抢（批量兑换吗）', intentOf({ title: '这玩意儿就没法儿批量兑换吗？', text: '' }) === 'qa');
t('真分享帖仍判 share（无问句）', intentOf({ title: '终于打过了，分享一下', text: '开心' }) === 'share');
console.log('\n== rewriteQuery 别名展开 ==');
const f = join(tmpdir(), `intent-${Date.now()}.sqlite`);
const db = openDb(f); initFacts(db);
addFact(db, { id: 'box', name: '钻石宝箱抽取', aliases: ['688'], attrs: {} });
const q = rewriteQuery({ title: '688是十连吗', text: '' }, { db });
t('别名展开带规范名', q.includes('688') && q.includes('钻石宝箱抽取'));
const q2 = rewriteQuery({ title: '你好[表情_开心]', text: '' }, {});
t('去表情标记', !q2.includes('[表情_'));
try { unlinkSync(f); } catch {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);