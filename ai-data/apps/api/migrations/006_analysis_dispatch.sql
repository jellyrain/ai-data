-- 调度记录与用户消息一起提交，工具摘要用于关联运行和证据。
SET XACT_ABORT ON;
BEGIN TRANSACTION;
DECLARE @lock_result INT;
EXEC @lock_result = sp_getapplock @Resource = N'ai-bi-api:metadata-schema',
  @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = 60000;
IF @lock_result < 0 THROW 51000, 'API metadata schema migration lock could not be acquired.', 1;
IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE migration_id = N'006_analysis_dispatch')
BEGIN
  CREATE TABLE dbo.analysis_dispatches (
    analysis_run_id NVARCHAR(128) NOT NULL PRIMARY KEY REFERENCES dbo.analysis_runs(id),
    session_id NVARCHAR(128) NOT NULL
  );
  CREATE TABLE dbo.analysis_tool_audits (
    analysis_run_id NVARCHAR(128) NOT NULL REFERENCES dbo.analysis_runs(id),
    tool_call_id NVARCHAR(128) NOT NULL,
    lease_epoch INT NOT NULL,
    audit_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(audit_json) = 1),
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    PRIMARY KEY (analysis_run_id, tool_call_id)
  );
  ALTER TABLE dbo.conversation_messages ADD analysis_run_id NVARCHAR(128) NULL;
  EXEC sp_executesql N'UPDATE m SET analysis_run_id = s.analysis_run_id FROM dbo.conversation_messages m
    JOIN dbo.conversation_submissions s ON s.message_id = m.id;';
  CREATE INDEX IX_analysis_runs_dispatch ON dbo.analysis_runs(status, created_at) INCLUDE(user_id,organization_id);
  INSERT INTO dbo.schema_migrations (migration_id) VALUES (N'006_analysis_dispatch');
END;
COMMIT TRANSACTION;
