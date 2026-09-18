/** 单次明细响应的合同硬上限；DAS 数据源配置可以设置更小的行数。 */
const MAX_QUERY_ROWS = 100000;
/** 标准化表格 JSON 的 UTF-8 字节预算，覆盖列定义和全部结果行。 */
const MAX_QUERY_TABLE_BYTES = 32 * 1024 * 1024;
/** 结果外层元数据预留的传输空间，API 在读取 DAS 响应时使用。 */
const MAX_QUERY_RESPONSE_BYTES = MAX_QUERY_TABLE_BYTES + 64 * 1024;

export { MAX_QUERY_ROWS, MAX_QUERY_TABLE_BYTES, MAX_QUERY_RESPONSE_BYTES };
