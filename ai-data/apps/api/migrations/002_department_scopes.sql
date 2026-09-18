-- 部门标识对应业务数据源中的权限字段，由 API 管理员按用户维护。
SET XACT_ABORT ON;
BEGIN TRANSACTION;
DECLARE @lock_result INT;
EXEC @lock_result = sp_getapplock @Resource = N'ai-bi-api:metadata-schema',
  @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = 60000;
IF @lock_result < 0 THROW 51000, 'API metadata schema migration lock could not be acquired.', 1;
IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE migration_id = N'002_department_scopes')
BEGIN
  CREATE TABLE dbo.user_department_scopes (
    user_id NVARCHAR(128) NOT NULL,
    department_id NVARCHAR(128) NOT NULL,
    PRIMARY KEY (user_id, department_id),
    FOREIGN KEY (user_id) REFERENCES dbo.users(id)
  );
  INSERT INTO dbo.schema_migrations (migration_id) VALUES (N'002_department_scopes');
END;
COMMIT TRANSACTION;
