import { z } from "zod";
import { columnOperationSchema } from "./column-operation";
import { queryOperatorSchema } from "../query/query-operators";

/** 权限策略允许引用的 API 权限计算上下文字段路径。 */
const permissionContextPath = z
  .string()
  .regex(/^permission_context\.[a-z_][a-z0-9_]*$/, "只能引用 permission_context 下的白名单字段");

/** 权限策略中允许使用的对象、字段和别名格式。 */
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/, "必须是安全标识符");

/** 权限条件允许的比较操作。 */
const policyOperator = queryOperatorSchema;

/** 权限条件中的固定值类型。 */
const policyLiteral = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/**
 * 一条表级行过滤条件。
 * value 和 value_from 二选一，不能同时提供。
 */
const rowConditionSchema = z
  .object({
    /** 要过滤的表字段。 */
    field: identifier,

    /** 权限条件操作符。 */
    op: policyOperator,

    /** 固定过滤值，例如 "completed" 或 1。 */
    value: z.union([policyLiteral, z.array(policyLiteral)]).optional(),

    /** 从 API 的权限计算上下文读取值，例如 permission_context.department_ids。 */
    value_from: permissionContextPath.optional(),
  })
  .strict()
  .superRefine((condition, context) => {
    const hasValue = condition.value !== undefined;
    const hasContextValue = condition.value_from !== undefined;

    if (condition.op === "is_null" || condition.op === "not_null") {
      if (hasValue || hasContextValue) {
        context.addIssue({
          code: "custom",
          message: "is_null 和 not_null 不能配置 value 或 value_from",
        });
      }

      return;
    }

    if (
      condition.op === "between" &&
      (!Array.isArray(condition.value) || condition.value.length !== 2)
    ) {
      context.addIssue({ code: "custom", message: "between 的 value 必须包含两个值" });
    }

    if (hasValue === hasContextValue) {
      context.addIssue({
        code: "custom",
        message: "普通比较条件必须且只能配置 value 或 value_from",
      });
    }
  });

/** 角色对表或视图的读取权限。 */
const tablePermissionSchema = z
  .object({
    /** 角色 ID。 */
    role_id: z.string().min(1, "role_id 不能为空"),

    /** 数据对象 ID，例如 clinical.surgery_record。 */
    object_id: identifier,

    /** allow 允许访问，deny 明确拒绝访问。 */
    effect: z.enum(["allow", "deny"]),
  })
  .strict();

/** 角色对某个对象的行过滤权限。 */
const rowPolicySchema = z
  .object({
    /** 角色 ID。 */
    role_id: z.string().min(1, "role_id 不能为空"),

    /** 应用过滤规则的数据对象。 */
    object_id: identifier,

    /** 当前版本只允许定义有效过滤规则。 */
    effect: z.literal("allow"),

    /** 该对象的行过滤条件。 */
    condition: rowConditionSchema,
  })
  .strict();

/** 角色对单个字段的可见性和 DSL 操作权限。 */
const columnPermissionSchema = z
  .object({
    /** 角色 ID。 */
    role_id: z.string().min(1, "role_id 不能为空"),

    /** 字段所属的数据对象。 */
    object_id: identifier,

    /** 需要控制的字段。 */
    column: identifier,

    /** allow 允许访问，deny 禁止访问。 */
    effect: z.enum(["allow", "deny"]),
    /** allow 未配置时默认全部操作；配置后只允许列出的操作。 */
    operations: z.array(columnOperationSchema).min(1).optional(),
  })
  .strict()
  .superRefine((permission, context) => {
    if (permission.effect === "deny" && permission.operations !== undefined) {
      context.addIssue({
        code: "custom",
        message: "effect 为 deny 时不应配置 operations",
      });
    }
  });

export { rowConditionSchema, tablePermissionSchema, rowPolicySchema, columnPermissionSchema };
