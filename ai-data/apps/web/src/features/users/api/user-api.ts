import { z } from "zod";
import {
  managedUserSchema,
  managedUserAuthorizationSchema,
  userAssignmentOptionsSchema,
  createManagedUserSchema,
  managedDepartmentsInputSchema,
  type CreateManagedUser,
  type ManagedDepartmentsInput,
} from "@ai-data/contracts";
import type { Transport } from "../../../shared/http/http-types";
import { ApiError } from "../../../shared/http/api-error";
/** 用户详情与绑定分别严格读取，所有请求的组织由登录身份确定。 */
class UserApi {
  constructor(private readonly request: Transport) {}
  async list() {
    return z
      .object({ items: z.array(managedUserSchema) })
      .strict()
      .parse(await this.request("/api/admin/users")).items;
  }
  async get(id: string) {
    return managedUserSchema.parse(
      await this.request(`/api/admin/users/${encodeURIComponent(id)}`),
    );
  }
  async authorization(id: string) {
    return managedUserAuthorizationSchema.parse(
      await this.request(`/api/admin/users/${encodeURIComponent(id)}/authorization`),
    );
  }
  async options() {
    return userAssignmentOptionsSchema.parse(
      await this.request("/api/admin/users/assignment-options"),
    );
  }
  async create(value: CreateManagedUser) {
    const body = createManagedUserSchema.parse(value);
    const raw = await this.request("/api/admin/users", { method: "POST", body });
    const result = managedUserSchema.safeParse(raw);
    if (!result.success)
      throw new ApiError("创建回执格式异常，请核对账号是否已创建", 502, "INVALID_RESPONSE");
    return result.data;
  }
  async departments(id: string, value: ManagedDepartmentsInput) {
    z.undefined().parse(
      await this.request(`/api/admin/users/${encodeURIComponent(id)}/departments`, {
        method: "PUT",
        body: managedDepartmentsInputSchema.parse(value),
      }),
    );
  }
  async status(id: string, enabled: boolean) {
    z.undefined().parse(
      await this.request(
        `/api/admin/users/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`,
        { method: "POST", body: {} },
      ),
    );
  }
}
export { UserApi };
