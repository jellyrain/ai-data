import {
  columnPermissionSchema,
  rowPolicySchema,
  tablePermissionSchema,
} from "../permission/permission-policy";
import { dateTimeSchema } from "../shared/data-values";
import { queryDslSchema } from "../query/query-dsl";
import { datasetSchema } from "../catalog/dataset";
import { apiDatasetConfigSchema } from "../catalog/api-dataset";
import { z } from "zod";

/** 管理接口沿用元数据主键长度，拒绝空标识。 */
const idSchema = z.string().min(1, "标识不能为空").max(128);
/** 可选的期望角色版本用于比较更新；0 表示该角色尚无版本记录。 */
const expectedVersionSchema = z.number().int().min(0).max(2_147_483_646).optional();
/** 对象权限写入体只接受数据源、共享权限字段及可选期望版本。 */
const objectPermissionInputSchema = tablePermissionSchema
  .extend({
    source_id: idSchema,
    expected_version: expectedVersionSchema,
  })
  .strict();
/** 字段权限复用共享合同的操作与 effect 联合校验。 */
const columnPermissionInputSchema = columnPermissionSchema
  .safeExtend({
    source_id: idSchema,
    expected_version: expectedVersionSchema,
  })
  .strict();
/** 行策略写入体保留共享条件结构，未知字段会被拒绝。 */
const rowPolicyInputSchema = rowPolicySchema
  .extend({
    source_id: idSchema,
    expected_version: expectedVersionSchema,
  })
  .strict();
/** 一次变更只影响一个角色的一项对象、字段或行规则。 */
const policyChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("object_permission"), permission: tablePermissionSchema }).strict(),
  z.object({ kind: z.literal("column_permission"), permission: columnPermissionSchema }).strict(),
  z.object({ kind: z.literal("row_policy"), permission: rowPolicySchema }).strict(),
]);
/** 每个版本保存该角色在目标源的完整规则，单类规则最多 10000 项。 */
const policySnapshotSchema = z
  .object({
    object_permissions: z.array(tablePermissionSchema).max(10000),
    column_permissions: z.array(columnPermissionSchema).max(10000),
    row_policies: z.array(rowPolicySchema).max(10000),
  })
  .strict();
/** 版本清单携带操作者与精确变更目标，条件和快照在版本详情中读取。 */
const policyVersionSummarySchema = z
  .object({
    organization_id: idSchema,
    source_id: idSchema,
    role_id: idSchema,
    version: z.number().int().positive(),
    changed_by: idSchema,
    changed_at: dateTimeSchema,
    summary: z
      .object({
        kind: z.enum(["object_permission", "column_permission", "row_policy"]),
        object_id: tablePermissionSchema.shape.object_id,
        effect: tablePermissionSchema.shape.effect,
        /** 只有字段权限变更需要列名。 */
        column: columnPermissionSchema.shape.column.optional(),
      })
      .strict(),
  })
  .strict();
/** 不可变策略版本详情，变更、审计摘要与完整快照共同持久化。 */
const policyVersionSchema = policyVersionSummarySchema
  .extend({
    change: policyChangeSchema,
    snapshot: policySnapshotSchema,
  })
  .strict();
/** 版本路径通过当前管理员身份补齐组织范围。 */
const policyParamsSchema = z.object({ sourceId: idSchema, roleId: idSchema }).strict();
/** 历史版本必须为正整数；当前版本使用单独的 current 路径。 */
const policyVersionParamsSchema = policyParamsSchema
  .extend({
    version: z.coerce.number().int().positive().max(2_147_483_647),
  })
  .strict();
/** 按版本倒序游标读取，每页默认 20 项、最多 100 项。 */
const policyListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    before_version: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  })
  .strict();
/** 预览仅接受目标角色和 DSL；组织与权限由服务端加载。 */
const queryPreviewInputSchema = z.object({ role_id: idSchema, query: queryDslSchema }).strict();

/** 当前表规则及最近角色版本，尚无历史时版本为 0。 */
const currentPolicyStateSchema = z
  .object({ version: z.number().int().nonnegative(), snapshot: policySnapshotSchema })
  .strict();
/** 完整管理目录详情；首次业务配置用 null 和版本 0 表示。 */
const adminDatasetDetailSchema = z
  .object({
    dataset: datasetSchema,
    config: apiDatasetConfigSchema.nullable(),
    config_version: z.number().int().nonnegative(),
  })
  .strict();

export {
  currentPolicyStateSchema,
  adminDatasetDetailSchema,
  columnPermissionInputSchema,
  objectPermissionInputSchema,
  policyChangeSchema,
  policyListQuerySchema,
  policyParamsSchema,
  policySnapshotSchema,
  policyVersionParamsSchema,
  policyVersionSchema,
  policyVersionSummarySchema,
  queryPreviewInputSchema,
  rowPolicyInputSchema,
};
