-- 指标和报告按组织、稳定标识及版本持久化，历史版本保存完整快照。
SET XACT_ABORT ON;
BEGIN TRANSACTION;
DECLARE @lock_result INT;
EXEC @lock_result = sp_getapplock @Resource = N'ai-bi-api:metadata-schema',
  @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = 60000;
IF @lock_result < 0 THROW 51000, 'API metadata schema migration lock could not be acquired.', 1;
IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE migration_id = N'004_metrics_and_reports')
BEGIN
  CREATE TABLE dbo.metric_definitions (
    organization_id NVARCHAR(128) NOT NULL REFERENCES dbo.organizations(id),
    metric_id NVARCHAR(128) NOT NULL, version INT NOT NULL,
    definition_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(definition_json)=1),
    PRIMARY KEY (organization_id,metric_id,version)
  );
  CREATE TABLE dbo.saved_reports (
    organization_id NVARCHAR(128) NOT NULL REFERENCES dbo.organizations(id),
    report_id NVARCHAR(128) NOT NULL, version INT NOT NULL, user_id NVARCHAR(128) NOT NULL REFERENCES dbo.users(id),
    report_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(report_json)=1),
    PRIMARY KEY (organization_id,report_id,version)
  );
  INSERT INTO dbo.schema_migrations (migration_id) VALUES (N'004_metrics_and_reports');
END;
COMMIT TRANSACTION;
