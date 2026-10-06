import { z } from "zod";
import { modelConfigurationSchema, modelConfigurationInputSchema } from "@ai-data/contracts";
import type { ModelConfiguration, ModelConfigurationInput } from "@ai-data/contracts";
import type { Transport } from "../../../shared/http/http-types";
import { publishVersion } from "../../../shared/management/version-publication";
/** 模型响应严格拒绝秘密字段，详情按用户选择的固定版本读取。 */
class ModelApi {
  constructor(private readonly request: Transport) {}
  async list() {
    return z
      .object({ items: z.array(modelConfigurationSchema) })
      .strict()
      .parse(await this.request("/api/models")).items;
  }
  async get(id: string, version?: number): Promise<ModelConfiguration> {
    return modelConfigurationSchema.parse(
      await this.request(
        `/api/models/${encodeURIComponent(id)}${version ? `?version=${version}` : ""}`,
      ),
    );
  }
  publish(input: ModelConfigurationInput) {
    return publishVersion({
      request: this.request,
      path: "/api/models",
      id: input.model_id,
      input: modelConfigurationInputSchema.parse(input),
      schema: modelConfigurationSchema,
      secret: true,
    });
  }
  async status(id: string, enabled: boolean) {
    z.undefined().parse(
      await this.request(`/api/models/${encodeURIComponent(id)}/status`, {
        method: "PATCH",
        body: { enabled },
      }),
    );
  }
}
export { ModelApi };
