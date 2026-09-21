import type { z } from "zod";
import type {
  modelConfigurationInputSchema,
  modelConfigurationSchema,
} from "./model-configuration";

/** 管理员提交的完整模型版本及认证。 */
type ModelConfigurationInput = z.infer<typeof modelConfigurationInputSchema>;
/** 可公开读取的模型版本。 */
type ModelConfiguration = z.infer<typeof modelConfigurationSchema>;

export type { ModelConfigurationInput, ModelConfiguration };
