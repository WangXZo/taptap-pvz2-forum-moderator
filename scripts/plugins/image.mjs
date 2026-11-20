// C10 插件：image（图片识别流水线）。内核经 onPost 调用，独立可开关(config.features.image)。
import { enrichPostImages } from '../lib/image.mjs';

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