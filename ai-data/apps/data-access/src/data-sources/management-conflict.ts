/** 数据源公开配置与用户读取基准不一致，在 HTTP 边界映射为 409。 */
class ManagementConflict extends Error {
  constructor() {
    super("配置已更新，请重新读取后保存");
    this.name = "ManagementConflict";
  }
}
export { ManagementConflict };
