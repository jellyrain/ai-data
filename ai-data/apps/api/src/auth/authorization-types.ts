/** 一条由 API 计算并注入 Query DSL 的数据权限策略。 */
type DataPolicy = {
  /** 数据策略适用的业务资源编码。 */
  resource: string;
  /** 必须注入过滤条件的字段编码。 */
  field: string;
  /** 策略允许的比较方式。 */
  operator: "eq" | "in";
  /** 由权限配置给出的固定过滤值。 */
  value: string | string[];
  /** 标记该条件为调用方不可移除的强制条件。 */
  mandatory: true;
};

export type { DataPolicy };
