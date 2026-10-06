import type { Node, Edge } from "@vue-flow/core";
/** 节点摘要只描述当前查询定义，查询结果在显式执行后读取。 */
type QueryNodeData = {
  queryId: string;
  alias: string;
  objectId: string;
  kind: string;
  columns: string[];
  conditions: number;
  primary: boolean;
};
/** 关系边使用已批准关系及连接类型。 */
type QueryEdgeData = { relationId: string; joinType: string; alias: string };
/** Vue Flow 视图由统一定义派生，不独立持久化业务字段。 */
type QueryGraph = { nodes: Node<QueryNodeData>[]; edges: Edge<QueryEdgeData>[] };
export type { QueryNodeData, QueryEdgeData, QueryGraph };
