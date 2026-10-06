import { z } from "zod";
import {
  userPreferenceSchema,
  preferenceEditStateSchema,
  preferenceConfirmationSchema,
  saveUserPreferenceInputSchema,
  saveUserPreferenceResultSchema,
} from "@ai-data/contracts";
import type { SaveUserPreferenceInput } from "@ai-data/contracts";
import type { Transport } from "../../../shared/http/http-types";
/** 个人设置只使用认证账号，保存始终携带当前版本和操作幂等键。 */
class PreferenceApi {
  constructor(private readonly request: Transport) {}
  async list() {
    return z
      .object({ items: z.array(userPreferenceSchema) })
      .strict()
      .parse(await this.request("/api/me/preferences")).items;
  }
  async confirmations() {
    return z
      .object({ items: z.array(preferenceConfirmationSchema) })
      .strict()
      .parse(await this.request("/api/me/preferences/confirmations")).items;
  }
  async editState(key: string) {
    return preferenceEditStateSchema.parse(
      await this.request("/api/me/preferences/" + encodeURIComponent(key) + "/edit-state"),
    );
  }
  async save(input: SaveUserPreferenceInput) {
    const { key, ...body } = saveUserPreferenceInputSchema.parse(input);
    return saveUserPreferenceResultSchema.parse(
      await this.request("/api/me/preferences/" + encodeURIComponent(key), { method: "PUT", body }),
    );
  }
  async remove(key: string, expected_version: number, idempotency_key: string) {
    z.undefined().parse(
      await this.request("/api/me/preferences/" + encodeURIComponent(key), {
        method: "DELETE",
        body: { expected_version, idempotency_key },
      }),
    );
  }
}
export { PreferenceApi };
