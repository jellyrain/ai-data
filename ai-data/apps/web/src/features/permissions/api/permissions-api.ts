import { z } from "zod";
import {
  currentPolicyStateSchema,
  policyVersionSchema,
  policyVersionSummarySchema,
  objectPermissionInputSchema,
  columnPermissionInputSchema,
  rowPolicyInputSchema,
  queryPreviewInputSchema,
  queryDslSchema,
  outputMaskSchema,
} from "@ai-data/contracts";
import type { Transport } from "../../../shared/http/http-types";
/** 当前实际规则和历史不可变快照使用各自接口，不用历史推断初始规则。 */
class PermissionsApi {
  constructor(private readonly request: Transport) {}
  private path(source: string, role: string) {
    return `${encodeURIComponent(source)}/${encodeURIComponent(role)}`;
  }
  async current(source: string, role: string) {
    return currentPolicyStateSchema.parse(
      await this.request(`/api/admin/catalog/policies/${this.path(source, role)}`),
    );
  }
  async history(source: string, role: string, before?: number) {
    return z
      .object({ items: z.array(policyVersionSummarySchema) })
      .strict()
      .parse(
        await this.request(
          `/api/admin/catalog/policy-versions/${this.path(source, role)}?limit=20${before ? `&before_version=${before}` : ""}`,
        ),
      ).items;
  }
  async version(source: string, role: string, version: number) {
    return policyVersionSchema.parse(
      await this.request(
        `/api/admin/catalog/policy-versions/${this.path(source, role)}/${version}`,
      ),
    );
  }
  async save(kind: "object" | "column" | "row", value: unknown) {
    const [suffix, schema] =
      kind === "object"
        ? (["object-permissions", objectPermissionInputSchema] as const)
        : kind === "column"
          ? (["column-permissions", columnPermissionInputSchema] as const)
          : (["row-policies", rowPolicyInputSchema] as const);
    z.undefined().parse(
      await this.request(`/api/admin/catalog/${suffix}`, {
        method: "PUT",
        body: schema.parse(value),
      }),
    );
  }
  async preview(value: unknown) {
    return z
      .object({
        role_id: z.string().min(1),
        query: queryDslSchema,
        output_masks: z.array(outputMaskSchema),
      })
      .strict()
      .parse(
        await this.request("/api/admin/catalog/query-preview", {
          method: "POST",
          body: queryPreviewInputSchema.parse(value),
        }),
      );
  }
}
export { PermissionsApi };
