/** 由角色范围或用户例外范围生成、供关系查询转换为行条件的权限策略。 */
type DataPolicy = {
  /** 查询转换时用于匹配目录 object_id 的业务资源编码。 */
  resource: string;
  /** 目标对象的字段名，由查询转换步骤补上对象别名。 */
  field: string;
  /** 策略允许的比较方式。 */
  operator: "eq" | "in";
  /** 固定权限值；当前仓储将 in 条件的逗号分隔文本拆为字符串数组。 */
  value: string | string[];
  /** 标记该条件为调用方不可移除的强制条件。 */
  mandatory: true;
};

export type { DataPolicy };
