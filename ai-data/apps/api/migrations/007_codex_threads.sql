-- 业务会话绑定官方线程，授权上下文变化时由 API 创建新的线程。
SET XACT_ABORT ON;
BEGIN TRANSACTION;
DECLARE @lock_result INT;
EXEC @lock_result = sp_getapplock @Resource = N'ai-bi-api:metadata-schema',
  @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = 60000;
IF @lock_result < 0 THROW 51000, 'API metadata schema migration lock could not be acquired.', 1;
IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE migration_id = N'007_codex_threads')
BEGIN
  CREATE TABLE dbo.analysis_codex_threads (
    conversation_id NVARCHAR(128) NOT NULL PRIMARY KEY REFERENCES dbo.conversations(id),
    thread_id NVARCHAR(128) NOT NULL,
    context_hash CHAR(64) NOT NULL,
    updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
  INSERT INTO dbo.schema_migrations (migration_id) VALUES (N'007_codex_threads');
END;
COMMIT TRANSACTION;
