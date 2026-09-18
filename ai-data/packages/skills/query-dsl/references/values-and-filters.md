# 值类型与过滤条件

过滤条件和参数都必须带真实 `data_type`，只使用以下类型：

| 类型       | JSON 值               |
| ---------- | --------------------- |
| `string`   | 字符串                |
| `integer`  | 整数                  |
| `decimal`  | 数字                  |
| `boolean`  | `true` 或 `false`     |
| `date`     | `YYYY-MM-DD`          |
| `datetime` | `YYYY-MM-DD HH:mm:ss` |
| `buffer`   | Base64 字符串         |

- `eq`、`neq` 使用单个值。
- `in`、`not_in` 使用非空数组，数组元素类型一致。
- `between` 使用恰好两个同类型值，并按起始值、结束值排列。
- `is_null`、`not_null` 不得携带 `value`。
- 日期与日期时间使用合同格式，不能传 ISO UTC、数据库函数或自然语言时间。
