import { stableStringify, type QueryEvidence } from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import type { ApiQueryAuthorization } from "../app-types";
import { ApplicationError } from "../errors/application-error";

/** 重新计算当前权限；仅在能够证明完整来源查询与输出策略仍相同时交付历史结果。 */
async function assertEvidenceAccess(
  evidence: QueryEvidence,
  context: AuthContext,
  authorization: ApiQueryAuthorization,
): Promise<void> {
  if (evidence.organization_id !== context.organizationId)
    throw new ApplicationError("UNAUTHORIZED", "无权访问证据来源");
  const current = await authorization.authorize(
    evidence.requested_query,
    context,
    evidence.analysis_run_id,
  );
  if (
    stableStringify(current.request.query) !== stableStringify(evidence.authorized_query) ||
    stableStringify(current.request.access.output_masks) !== stableStringify(evidence.output_masks)
  )
    throw new ApplicationError(
      "POLICY_REJECTED",
      "当前权限不能确认覆盖历史结果的完整范围，请重新执行查询",
    );
}
export { assertEvidenceAccess };
