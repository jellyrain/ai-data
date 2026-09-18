---
name: query-dsl
description: Build validated AI BI query DSL from API-provided datasets, fields, parameters, and approved relations. Use when turning an analysis question into a data query; do not use for free SQL or DAS administration.
---

# Query DSL

将业务问题转换为 API 工具可接收的结构化查询 DSL。根据已授权目录确认对象、字段、查询能力、参数及批准关系；口径或对象信息不足时先探索目录或澄清。

## 按需读取

使用 `read_skill_reference` 读取本 Skill 的子文档：`skill_name` 固定为 `query-dsl`，`relative_path` 使用下表中的路径。按当前任务读取需要的文档，再构造查询。

| 当前任务                                       | 查询类型或用途                                             | 子文档路径                                                             |
| ---------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| 目录对象为 `table` 或 `view`                   | 使用 `relational_query`，返回字段与聚合由查询指定          | [references/relational-query.md](references/relational-query.md)       |
| 目录对象为 `stored_procedure` 或 `api_dataset` | 使用 `parameterized_query`，传入目录声明的参数，输出列固定 | [references/parameterized-query.md](references/parameterized-query.md) |
| 多明细关联或需要按复合键去重                   | 在关系查询基础上选择分层聚合                               | [references/pre-aggregation.md](references/pre-aggregation.md)         |
| 构造过滤条件或参数值                           | 按字段类型确定值、操作符和日期格式                         | [references/values-and-filters.md](references/values-and-filters.md)   |

## 执行规则

- 对象类型和可用能力以目录返回值为准。查询失败时核对错误码、目录及对应子文档，修正查询后再调用。
- 使用目录中的逻辑对象 ID、字段、唯一键和批准关系；指标的时间依据、粒度及总计规则以已确认定义为准。
- DSL 只表达业务查询意图，不包含 SQL、数据库函数、连接串、HTTP URL、JSONPath 或自由表达式。身份、行权限、列权限、脱敏规则、JWT 和签名由 API 绑定。
- 查询使用当前数据源内已批准的关系。跨源需求由 API 分别查询并受控合并。
- 根据工具结果核对空值、完整性、截断和聚合口径，再引用证据回答；结果与口径冲突时重新核对目录或澄清。
