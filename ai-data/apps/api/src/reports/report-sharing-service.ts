import {
  reportShareCandidatesInputSchema,
  reportShareCandidatesSchema,
  reportSharingSchema,
} from "@ai-data/contracts";
import type { ReportShareCandidates, ReportSharing } from "@ai-data/contracts";
import type { AuthContext } from "../auth/auth-types";
import { ApplicationError } from "../errors/application-error";
import type { ReportSharingDependencies, ReportSharingHead } from "./report-sharing-types";

/** 分享读取先经过完整报表授权，再核对作者；账号查询不接受客户端组织或用户身份。 */
class ReportSharingService {
  constructor(private readonly dependencies: ReportSharingDependencies) {}

  async get(context: AuthContext, id: string): Promise<ReportSharing> {
    const { head, basis } = await this.head(context, id);
    const sharedWith = [...new Set(head.shared_with)];
    const members = await this.dependencies.repository.members(context.organizationId, sharedWith);
    const byId = new Map(members.map((member) => [member.user_id, member]));
    return reportSharingSchema.parse({
      report_id: id,
      basis,
      expected_version: head.version,
      owner_user_id: head.user_id,
      shared_with: sharedWith,
      members: sharedWith.map(
        (userId) =>
          byId.get(userId) ?? {
            user_id: userId,
            username: null,
            display_name: null,
            status: "unavailable",
          },
      ),
    });
  }

  async candidates(
    context: AuthContext,
    id: string,
    input: unknown,
  ): Promise<ReportShareCandidates> {
    const request = reportShareCandidatesInputSchema.parse(input);
    await this.head(context, id);
    const found = await this.dependencies.repository.candidates(
      context.organizationId,
      context.userId,
      {
        ...request,
        limit: request.limit + 1,
      },
    );
    const items = found.slice(0, request.limit);
    return reportShareCandidatesSchema.parse({
      items,
      ...(found.length > request.limit ? { next_cursor: items.at(-1)!.user_id } : {}),
    });
  }

  private async head(context: AuthContext, id: string) {
    let head: ReportSharingHead;
    let basis: ReportSharing["basis"] = "definition";
    try {
      head = await this.dependencies.definitions.get(context, id);
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.code !== "NOT_FOUND") throw error;
      basis = "snapshot";
      head = await this.dependencies.reports.get(context, id);
    }
    if (head.organization_id !== context.organizationId || head.user_id !== context.userId)
      throw new ApplicationError("NOT_FOUND", "报表不存在或不可管理分享");
    return { head, basis };
  }
}

export { ReportSharingService };
