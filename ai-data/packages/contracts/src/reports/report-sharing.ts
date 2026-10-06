import { z } from "zod";

const id = z.string().min(1).max(128);
/** 作者选择成员所需的最少资料，拒绝额外身份或管理字段。 */
const reportShareCandidateSchema = z
  .object({
    user_id: id,
    username: z.string().min(1).max(256),
    display_name: z.string().min(1).max(256),
  })
  .strict();
/** 已选账号允许停用、待启用或已失效；失效账号仅保留原 ID 便于移除。 */
const reportShareMemberSchema = reportShareCandidateSchema
  .extend({
    username: reportShareCandidateSchema.shape.username.nullable(),
    display_name: reportShareCandidateSchema.shape.display_name.nullable(),
    status: z.enum(["active", "disabled", "pending", "unavailable"]),
  })
  .superRefine((member, context) => {
    const missing = member.status === "unavailable";
    if ((member.username === null) !== missing || (member.display_name === null) !== missing)
      context.addIssue({ code: "custom", message: "账号资料须与可用状态一致" });
  });
/** 当前分享基准取头版本，定义与快照采用各自版本序列；已选成员最多一千项。 */
const reportSharingSchema = z
  .object({
    report_id: id,
    basis: z.enum(["definition", "snapshot"]),
    expected_version: z.number().int().positive(),
    owner_user_id: id,
    shared_with: z.array(id).max(1000),
    members: z.array(reportShareMemberSchema).max(1000),
  })
  .strict()
  .superRefine((sharing, context) => {
    if (
      new Set(sharing.shared_with).size !== sharing.shared_with.length ||
      sharing.members.length !== sharing.shared_with.length ||
      sharing.members.some((member, index) => member.user_id !== sharing.shared_with[index])
    )
      context.addIssue({ code: "custom", message: "已选成员资料须与账号列表逐项一致且唯一" });
  });
/** 搜索限制为 80 字，按账号 ID 稳定翻页；默认返回 20 条，最多 100 条。 */
const reportShareCandidatesInputSchema = z
  .object({
    search: z.string().trim().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: id.optional(),
  })
  .strict();
/** 候选只包含当前组织活跃成员，省略游标表示已无后续记录。 */
const reportShareCandidatesSchema = z
  .object({
    items: z.array(reportShareCandidateSchema).max(100),
    next_cursor: id.optional(),
  })
  .strict();

export {
  reportShareCandidateSchema,
  reportShareMemberSchema,
  reportSharingSchema,
  reportShareCandidatesInputSchema,
  reportShareCandidatesSchema,
};
