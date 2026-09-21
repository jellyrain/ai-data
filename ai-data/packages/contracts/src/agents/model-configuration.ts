import { z } from "zod";

/** 模型地址只允许 HTTP(S)，认证通过独立字段提供。 */
const modelUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  }, "模型地址必须是无内嵌凭据的 HTTP(S) URL");
/** 版本固定的模型连接定义；公开字段不包含认证原文。 */
const modelFields = {
  model_id: z.string().min(1).max(128),
  version: z.number().int().positive(),
  name: z.string().min(1).max(200),
  protocol: z.literal("responses"),
  base_url: modelUrlSchema,
  model: z.string().min(1).max(200),
  context_window: z.number().int().min(4096).max(2097152).optional(),
};
/** 管理员提交的模型配置。每个版本显式保存自己的认证；省略表示该版本不使用该认证项。 */
const modelConfigurationInputSchema = z
  .object({
    ...modelFields,
    api_key: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[^\r\n]+$/)
      .optional(),
    headers: z
      .record(
        z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
        z
          .string()
          .max(8192)
          .regex(/^[^\r\n]*$/),
      )
      .refine((value) => Object.keys(value).length <= 20, "请求头最多 20 项")
      .optional(),
  })
  .strict();
/** API 返回的模型版本。只暴露认证是否存在和请求头名称，服务端文件保存实际认证。 */
const modelConfigurationSchema = z
  .object({
    ...modelFields,
    enabled: z.boolean(),
    has_api_key: z.boolean(),
    header_names: z.array(z.string().min(1)).max(20),
  })
  .strict();

export { modelConfigurationInputSchema, modelConfigurationSchema };
