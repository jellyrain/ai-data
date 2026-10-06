import { reportShareCandidateSchema, reportShareMemberSchema } from "@ai-data/contracts";
import type { ReportShareCandidatesInput } from "@ai-data/contracts";
import type { MetadataQueryExecutor } from "@ai-data/metadata";
import { parseStoredRecord } from "../metadata/parse-stored-record";
import type { ReportSharingRepository } from "./report-sharing-types";

/** 作者范围的账号摘要读取，SQL 只投影所需字段；组织与分页始终参数化。 */
class SqlReportSharingRepository implements ReportSharingRepository {
  constructor(private readonly database: MetadataQueryExecutor) {}

  async members(organizationId: string, userIds: string[]) {
    if (!userIds.length) return [];
    const result = await this.database.execute({
      sql: "SELECT id AS user_id,username,display_name,status FROM dbo.users WHERE organization_id=@org AND id IN (SELECT [value] FROM OPENJSON(@ids))",
      parameters: [
        { name: "org", type: "string", value: organizationId },
        { name: "ids", type: "string", value: JSON.stringify(userIds) },
      ],
    });
    return result.rows.map((row) => parseStoredRecord(() => reportShareMemberSchema.parse(row)));
  }

  async candidates(organizationId: string, ownerUserId: string, input: ReportShareCandidatesInput) {
    // SQL Server 的 LIKE 特殊字符按字面搜索，防止通配符改变候选范围。
    const search = input.search ? `%${input.search.replace(/[\\%_[\]]/g, "\\$&")}%` : null;
    const result = await this.database.execute({
      sql: "SELECT TOP (@limit) id AS user_id,username,display_name FROM dbo.users WHERE organization_id=@org AND status='active' AND id<>@owner AND (@cursor IS NULL OR id>@cursor) AND (@search IS NULL OR username LIKE @search ESCAPE '\\' OR display_name LIKE @search ESCAPE '\\') ORDER BY id",
      parameters: [
        { name: "org", type: "string", value: organizationId },
        { name: "owner", type: "string", value: ownerUserId },
        { name: "cursor", type: "string", value: input.cursor ?? null },
        { name: "search", type: "string", value: search },
        { name: "limit", type: "integer", value: input.limit },
      ],
    });
    return result.rows.map((row) => parseStoredRecord(() => reportShareCandidateSchema.parse(row)));
  }
}

export { SqlReportSharingRepository };
