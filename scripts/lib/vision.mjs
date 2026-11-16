// S4 VLM 看图理解（跟随 DSH + 他人 key，2026-11-16）
//
// 渠道完全复用 llm.mjs：① config.llm.vision（他人 key）② 跟随 DSH 路由挑 vision-capable 模型。
// 下载图片（CDN 无防盗链）→ base64 → 多模态消息 → chatVision。
// 无可用视觉渠道 / 失败 → 降级返回空（不抛错），调用方按「没识别到」处理（可转 agent-in-loop）。
//
// 重点图片类型（大哥 2026-11-16）：活动页面（植物/奖励/条件）、植物图鉴（植物/说明文本/技能）。

import { createHash } from 'node:crypto';
import { chatVision, resolveVisionChannels } from './llm.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const DEFAULT_PROMPT = `你是《植物大战僵尸2》论坛的看图助手。仔细看这张/这些游戏截图，用简洁中文输出要点（只描述图里真实可见的内容，看不清的不要猜，不要编造）：
- 场景类型：错误弹窗 / 关卡进度 / 植物阵容 / 活动页面 / 植物图鉴 / 其他
- 植物名称（若可见）
- 活动页面：活动名称、奖励物品及数量、参与条件、剩余时间
- 植物图鉴：植物名称、属性数值、技能/说明文本摘要
- 错误弹窗：错误文案、错误码
- 玩家可能在问什么
直接输出要点文本，不要用 markdown 标题。`;

async function downloadBase64(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://www.taptap.cn/' } });
  if (!r.ok) throw new Error(`下载图片 HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 100) throw new Error('图片过小/无效');
  return buf.toString('base64');
}

/**
 * 看图理解一组图片（合并为一次多模态调用，省成本）。
 * @returns {{text:string, sources:string[]}}
 */
export async function describeImages(images, { config = {}, log = () => {}, cache = null, prompt = '' } = {}) {
  const vc = config?.image?.vision || {};
  const list = (images || []).filter((im) => im?.url);
  if (!list.length) return { text: '', sources: [] };

  const key = 'vlm:' + createHash('sha1').update(list.map((i) => i.url).join('|') + (prompt || '')).digest('hex');
  const cached = cache?.get?.(key);
  if (cached) return { text: cached.text || '', sources: cached.text ? ['vlm'] : [] };

  // 下载 → base64（不依赖 VLM 服务端去抓 TapTap URL，更稳）
  const content = [{ type: 'text', text: prompt || DEFAULT_PROMPT }];
  for (const im of list) {
    try {
      const b64 = await downloadBase64(im.url);
      const mediaType = im.format ? `image/${im.format === 'jpg' ? 'jpeg' : im.format}` : 'image/jpeg';
      content.push({ type: 'image', base64: b64, mediaType });
    } catch (e) {
      log(`  [VLM] 图片下载跳过 ${String(im.url).slice(0, 48)}…：${e.message}`);
    }
  }
  if (content.length < 2) return { text: '', sources: [] }; // 没下到任何图

  const r = await chatVision(config, {
    system: '你看图说话，只描述图里真实可见的内容，不编造。',
    messages: [{ role: 'user', content }],
    temperature: Number(vc.temperature ?? 0.3),
    maxTokens: Number(vc.maxTokens ?? 1200),
    timeoutMs: Number(vc.timeoutMs ?? 90000),
    log,
  });
  if (!r.ok) {
    log(`  [VLM] 无可用渠道/失败：${r.error}`);
    return { text: '', sources: [] };
  }
  cache?.set?.(key, { text: r.text });
  return { text: r.text, sources: ['vlm'] };
}

export { resolveVisionChannels };