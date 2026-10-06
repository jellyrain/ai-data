import type { ReportQueryItem } from "@ai-data/contracts";
/** 报表关系查询的编辑类型，直接复用公共合同推导。 */
type RelationalReportQuery = Extract<ReportQueryItem["query"], { type: "relational_query" }>;
/** 参数化数据集的固定输入编辑类型。 */
type ParameterizedReportQuery = Extract<ReportQueryItem["query"], { type: "parameterized_query" }>;
/** 筛选组与条件沿用关系查询合同。 */
type FilterGroup = RelationalReportQuery["filters"];
/** 单条带类型的筛选，排除嵌套组。 */
type FilterCondition = Exclude<FilterGroup["items"][number], { logic: string }>;
/** 表单字段选项包含引用、用户说明和可用比较符。 */
type EditorField = {
  name: string;
  label: string;
  dataType: FilterCondition["data_type"];
  operators?: FilterCondition["op"][];
};
export type {
  RelationalReportQuery,
  ParameterizedReportQuery,
  FilterGroup,
  FilterCondition,
  EditorField,
};
