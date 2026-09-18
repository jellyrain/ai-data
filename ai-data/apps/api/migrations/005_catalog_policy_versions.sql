-- 目录策略版本按组织与数据源递增，每次保存目标角色完整规则及变更审计。
SET XACT_ABORT ON;
BEGIN TRANSACTION;
DECLARE @lock_result INT;
EXEC @lock_result = sp_getapplock @Resource = N'ai-bi-api:metadata-schema',
  @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = 60000;
IF @lock_result < 0 THROW 51000, 'API metadata schema migration lock could not be acquired.', 1;
IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE migration_id = N'005_catalog_policy_versions')
BEGIN
  -- 缺省字段操作以 SQL NULL 表达，统一已有记录的持久化形态。
  UPDATE dbo.role_column_permissions SET operations_json = NULL WHERE operations_json = N'null';
  CREATE TABLE dbo.catalog_policy_versions (
    organization_id NVARCHAR(128) NOT NULL REFERENCES dbo.organizations(id),
    source_id NVARCHAR(128) NOT NULL,
    role_id NVARCHAR(128) NOT NULL REFERENCES dbo.roles(id),
    version INT NOT NULL CHECK (version > 0),
    record_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(record_json)=1),
    PRIMARY KEY (organization_id,source_id,version)
  );
  CREATE INDEX ix_catalog_policy_role_versions
    ON dbo.catalog_policy_versions (organization_id,source_id,role_id,version DESC);
  INSERT INTO dbo.schema_migrations (migration_id) VALUES (N'005_catalog_policy_versions');
END;
COMMIT TRANSACTION;
