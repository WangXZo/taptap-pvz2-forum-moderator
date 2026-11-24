// C10 插件：image（图片识别流水线）。
// 识别实现在独立能力包 `pvz2-image-recognition` 里，这里经薄壳调用
// （lib/image-bridge.mjs：找到它、注入判定逻辑、失败就静默降级）。
// 能力包没装 → 跳过图片识别，主流程照跑。
// 内核经 onPost 调用，独立可开关(config.features.image)。
import { enrichPostImages } from '../lib/image-bridge.mjs';

export default {
  id: 'image',
  async init() {},
  // 帖级钩子：返回图片增强结果 {text,imageText,images,celebrate,sources,skipped}
  async onPost(item, ctx) {
    return enrichPostImages(item, {
      config: ctx.config,
      log: ctx.log,
      title: ctx.title,
      text: ctx.text,
      cache: ctx.cache,
    });
  },
};
