-- 运行快照、事件、工具证据和幂等提交共同支持崩溃后的恢复。
SET XACT_ABORT ON;
BEGIN TRANSACTION;
DECLARE @lock_result INT;
EXEC @lock_result = sp_getapplock @Resource = N'ai-bi-api:metadata-schema',
  @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = 60000;
IF @lock_result < 0 THROW 51000, 'API metadata schema migration lock could not be acquired.', 1;
IF NOT EXISTS (SELECT 1 FROM dbo.schema_migrations WHERE migration_id = N'003_analysis_runtime')
BEGIN
  CREATE TABLE dbo.analysis_run_states (
    analysis_run_id NVARCHAR(128) NOT NULL PRIMARY KEY REFERENCES dbo.analysis_runs(id),
    state_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(state_json) = 1)
  );
  CREATE TABLE dbo.analysis_run_events (
    analysis_run_id NVARCHAR(128) NOT NULL REFERENCES dbo.analysis_runs(id),
    sequence INT NOT NULL, event_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(event_json) = 1),
    PRIMARY KEY (analysis_run_id, sequence)
  );
  CREATE TABLE dbo.analysis_evidence (
    evidence_id NVARCHAR(128) NOT NULL PRIMARY KEY,
    analysis_run_id NVARCHAR(128) NOT NULL REFERENCES dbo.analysis_runs(id),
    tool_call_id NVARCHAR(128) NOT NULL,
    evidence_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(evidence_json) = 1),
    UNIQUE (analysis_run_id, tool_call_id)
  );
  CREATE TABLE dbo.analysis_steps (
    step_id NVARCHAR(128) NOT NULL,
    analysis_run_id NVARCHAR(128) NOT NULL REFERENCES dbo.analysis_runs(id),
    step_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(step_json) = 1),
    PRIMARY KEY (analysis_run_id, step_id)
  );
  CREATE TABLE dbo.analysis_run_operations (
    analysis_run_id NVARCHAR(128) NOT NULL REFERENCES dbo.analysis_runs(id),
    idempotency_key NVARCHAR(128) NOT NULL, request_hash CHAR(64) NOT NULL,
    PRIMARY KEY (analysis_run_id, idempotency_key)
  );
  CREATE TABLE dbo.conversation_submissions (
    conversation_id NVARCHAR(128) NOT NULL REFERENCES dbo.conversations(id),
    idempotency_key NVARCHAR(128) NOT NULL, request_hash CHAR(64) NOT NULL,
    message_id NVARCHAR(128) NOT NULL REFERENCES dbo.conversation_messages(id),
    analysis_run_id NVARCHAR(128) NOT NULL REFERENCES dbo.analysis_runs(id),
    PRIMARY KEY (conversation_id, idempotency_key)
  );
  -- 已有运行从基础记录建立快照，保持原有归属和终态。
  INSERT INTO dbo.analysis_run_states (analysis_run_id, state_json)
  SELECT r.id, (SELECT r.id AS analysis_run_id, r.conversation_id, r.organization_id, r.user_id, r.status,
    CONVERT(VARCHAR(19), DATEADD(HOUR, 8, r.created_at), 120) AS created_at,
    CONVERT(VARCHAR(19), DATEADD(HOUR, 8, r.created_at), 120) AS updated_at,
    0 AS lease_epoch, NULL AS lease, 0 AS sequence, NULL AS clarification,
    JSON_QUERY('[]') AS evidence_ids, NULL AS error FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)
  FROM dbo.analysis_runs r;
  INSERT INTO dbo.schema_migrations (migration_id) VALUES (N'003_analysis_runtime');
END;
COMMIT TRANSACTION;
