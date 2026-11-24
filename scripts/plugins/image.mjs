// C10 插件：image（图片识别）。
// 识别实现在独立能力包 `image-recognition-ai-ocr` 里，这里经薄壳调用
// （lib/image-recognition.mjs：业务门控 + 注入本项目 prompt/模板 + 失败降级）。
// 能力包没装 → 跳过图片识别，主流程照跑。
// 内核经 onPost 调用，独立可开关(config.features.image)。
import { enrichPostImages } from '../lib/image-recognition.mjs';

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