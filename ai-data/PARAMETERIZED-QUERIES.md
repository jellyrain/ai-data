# 参数化数据集配置与验收

存储过程和 HTTP 虚拟表通过固定输入、固定输出定义进入查询链。DAS 保存实际调用定义，API 根据当前用户权限生成最终参数、审核完整输出并签名。配置完成后，应先用目标数据库或接口的测试环境验收，再开放给业务角色。

## 存储过程

DAS 首建迁移 `001_initial_das_metadata_schema.sql` 在 `dbo.exposed_source_objects` 中创建 `procedure_definition_json`。管理员通过现有对象白名单接口 `PUT /internal/admin/data-source-objects` 保存定义；该接口替换整个数据源的白名单，请包含所有需要保留的对象。

以下为 SQL Server 的示例请求。`object_id` 应使用管理目录实际发现的标识，参数按数据库声明顺序填写：

```json
{
  "source_id": "reporting",
  "objects": [
    {
      "object_id": "stored_procedure.dbo.department_summary",
      "procedure_definition": {
        "query_parameters": [
          {
            "name": "p_department",
            "allowed_ops": ["eq"],
            "data_type": "string",
            "required": true
          }
        ],
        "columns": [
          { "name": "department", "data_type": "string", "nullable": false },
          { "name": "record_count", "data_type": "integer", "nullable": false }
        ]
      }
    }
  ]
}
```

- `query_parameters` 完整列出输入参数（PostgreSQL 包括 INOUT），名称唯一，当前调用支持标量 `eq`。类型和默认值在保存及调用时校验。
- `columns` 完整列出单一表格结果的所有列，至少一列且名称唯一。即使返回零行，结果也须带有符合定义的列元数据。
- `default_value` 在调用方省略参数时显式绑定。SQL Server 使用命名参数，可省略没有显式默认值的非必填参数，由数据库处理默认值；MySQL 和 PostgreSQL 使用位置参数，所有输入必须由请求或配置默认值补齐。
- SQL Server、MySQL 当前按 IN 输入和单一表格结果建模，额外 OUT 参数定义及多个结果集会被拒绝。管理员须确认过程只读、参数确实控制所声明的数据范围，执行账号权限与过程实现也须验收。
- PostgreSQL 使用 `CALL`。每个 IN/INOUT 参数必须在 `postgresql_parameter_types` 中按顺序声明原生类型，例如 `["text", "integer"]`，DAS 据此显式转换占位符以确定调用签名。受控类型包括 `text`、`varchar`、`smallint`、`integer`、`bigint`、`numeric`、`real`、`double precision`、`boolean`、`date`、`timestamp`、`bytea`。
- PostgreSQL 的 OUT-only 参数另写入 `output_parameters`，每项包括 `name`、`data_type` 和零基 `position`。位置按包含所有 IN、INOUT、OUT 参数的完整签名计算，DAS 在 OUT-only 槽位传入 `NULL`；INOUT 仍列在输入中。当前消费 `CALL` 返回的一张输出参数表，游标及多结果集需要另行实现。
- Oracle 表和视图继续走关系查询；Oracle 存储过程的游标和隐式结果集调用仍待实现，当前规划阶段会拒绝。

缺少完整定义的过程仍可被管理员发现，但不能执行。支持的调用形态配置完整后，业务目录才声明 `has_complete_output: true`。

## HTTP 虚拟表

固定请求路径和响应 JSONPath 保存在 DAS 的 `dbo.api_dataset_response_mappings`。`request_parameter_mappings_json` 中每个参数现在必须包含 `dataType` 和 `required`；可用 `defaultValue` 提供经过类型校验的默认值：

```json
[
  {
    "name": "p_department",
    "location": "query",
    "key": "department",
    "dataType": "string",
    "required": true
  }
]
```

`location` 支持 `query`、`header`、`body`，参数只能进入管理员配置的位置。响应字段继续使用 `field_mappings_json` 的 `name`、`json_path`、`data_type`、`nullable` 定义；至少配置一列。输入参数未知、重复、缺失、类型不匹配，或响应违反固定输出定义时均会失败。

已有 HTTP 参数映射需补齐类型和必填声明，旧 JSON 不会被猜测为字符串。映射由 DAS 本地管理，查询请求不能提供响应取值路径。

## API 权限绑定

API 的数据集业务配置可添加以下字段，将行权限字段对应到真正限制返回范围的输入参数：

```json
{
  "query_permission_bindings": [
    { "field": "department", "parameter": "p_department", "operator": "eq" }
  ]
}
```

管理员必须验收数据源实现满足“返回记录的该字段等于传入参数”的约定。字段与参数必须存在、类型相同且一一对应。

API 先合并当前角色的允许范围及强制范围，再验证参数。当前权限绑定支持标量等值参数，行条件支持 `eq`、`in` 及其 AND/OR 组合。省略权限参数时，只有整个有效权限范围能证明该参数值唯一才自动补入；存在多个可选值时，调用方须明确选择一个获准值。绑定缺失、条件无法表达、值超出范围或推导复杂度超出上限时拒绝签发。普通业务默认值不能替代权限范围推导。

固定调用不能通过挑选返回列避开列权限。API 使用 DAS 的完整输出清单检查每一列；任意列不可访问时拒绝整个调用，需要脱敏的列随请求携带处理规则。API 重建 `expected_output` 并纳入签名，DAS 将其与本地定义及实际输出核对。列名、类型或可空性变化后需要刷新目录并重新授权；字段说明及列顺序不影响授权集合。

## 升级与验证

1. 在测试环境执行 DAS 启动迁移，保存已审核的过程定义，补齐已有 HTTP 参数映射。
2. 协调升级 API 与 DAS，刷新目录并核对 `has_complete_output`。新版 DAS 拒绝缺少 `expected_output` 的固定调用；旧 API 的参数化请求需要随版本更新。
3. 验证合法参数、默认值、必填缺失、越权参数、禁止列、脱敏、零行结果及输出定义变化。分别确认数据库或接口实际执行的参数与权限绑定一致。
4. 通过可控慢查询验证排队、超时、取消及连接释放，并核对 DAS SQL Server 审计记录。单元测试和本地 HTTP 测试已覆盖这些控制路径，真实数据库驱动及迁移行为仍须在专用环境验收。

查询响应继续遵守数据源返回行数上限，超出时设置 `truncated: true`。完整大批量明细的分页与异步交付属于后续查询能力，需要独立的结果完整性与权限验收。
