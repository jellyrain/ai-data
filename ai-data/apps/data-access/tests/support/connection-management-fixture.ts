/** 非连接路由测试使用空列表，意外写入直接失败。 */
function connectionManagementFixture() {
  const unused = async (): Promise<never> => {
    throw new Error("测试未配置数据库连接操作");
  };
  return {
    list: async () => ({ items: [] }),
    get: unused,
    create: unused,
    update: unused,
    remove: unused,
    test: unused,
    testDraft: unused,
  };
}
export { connectionManagementFixture };
