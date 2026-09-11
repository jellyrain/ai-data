SET XACT_ABORT ON;
BEGIN TRANSACTION;

DECLARE @migration_lock_result INT;
EXEC @migration_lock_result = sp_getapplock
  @Resource = N'das:metadata-schema',
  @LockMode = N'Exclusive',
  @LockOwner = N'Transaction',
  @LockTimeout = 60000;

IF @migration_lock_result < 0
  THROW 51000, 'DAS metadata schema migration lock could not be acquired.', 1;

IF NOT EXISTS (
  SELECT 1 FROM dbo.schema_migrations WHERE migration_id = N'001_initial_das_metadata_schema'
)
BEGIN
  IF OBJECT_ID(N'dbo.data_source_secrets', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.data_source_secrets (
      secret_ref NVARCHAR(128) NOT NULL PRIMARY KEY,
      encryption_algorithm NVARCHAR(64) NOT NULL,
      key_id NVARCHAR(128) NOT NULL,
      encrypted_payload VARBINARY(MAX) NOT NULL,
      encryption_metadata_json NVARCHAR(MAX) NOT NULL,
      created_at DATETIME2(3) NOT NULL DEFAULT GETDATE(),
      updated_at DATETIME2(3) NOT NULL DEFAULT GETDATE()
    );
  END;

  IF OBJECT_ID(N'dbo.data_source_configs', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.data_source_configs (
      source_id NVARCHAR(128) NOT NULL PRIMARY KEY,
      connector_kind VARCHAR(32) NOT NULL,
      secret_ref NVARCHAR(128) NOT NULL,
      target_database NVARCHAR(128) NULL,
      oracle_connect_type VARCHAR(16) NULL,
      oracle_connect_target NVARCHAR(128) NULL,
      is_enabled BIT NOT NULL DEFAULT 1,
      timeout_ms INT NOT NULL,
      connection_pool_limit INT NOT NULL,
      concurrency_limit INT NOT NULL,
      row_limit INT NOT NULL,
      cost_limit INT NOT NULL,
      created_at DATETIME2(3) NOT NULL DEFAULT GETDATE(),
      updated_at DATETIME2(3) NOT NULL DEFAULT GETDATE()
    );
  END;

  IF OBJECT_ID(N'dbo.exposed_source_objects', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.exposed_source_objects (
      source_id NVARCHAR(128) NOT NULL,
      object_id NVARCHAR(256) NOT NULL,
      object_kind VARCHAR(32) NOT NULL,
      native_schema_name NVARCHAR(128) NULL,
      native_object_name NVARCHAR(256) NULL,
      is_discoverable BIT NOT NULL DEFAULT 1,
      is_queryable BIT NOT NULL DEFAULT 1,
      capabilities_json NVARCHAR(MAX) NOT NULL DEFAULT N'{}',
      created_at DATETIME2(3) NOT NULL DEFAULT GETDATE(),
      updated_at DATETIME2(3) NOT NULL DEFAULT GETDATE(),
      CONSTRAINT PK_exposed_source_objects PRIMARY KEY (source_id, object_id)
    );
  END;

  IF OBJECT_ID(N'dbo.api_dataset_response_mappings', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.api_dataset_response_mappings (
      source_id NVARCHAR(128) NOT NULL,
      object_id NVARCHAR(256) NOT NULL,
      request_method VARCHAR(8) NOT NULL,
      request_path NVARCHAR(2048) NOT NULL,
      request_parameter_mappings_json NVARCHAR(MAX) NOT NULL DEFAULT N'[]',
      response_mode VARCHAR(16) NOT NULL,
      response_path NVARCHAR(2048) NOT NULL,
      field_mappings_json NVARCHAR(MAX) NOT NULL,
      created_at DATETIME2(3) NOT NULL DEFAULT GETDATE(),
      updated_at DATETIME2(3) NOT NULL DEFAULT GETDATE(),
      CONSTRAINT PK_api_dataset_response_mappings PRIMARY KEY (source_id, object_id)
    );
  END;

  IF OBJECT_ID(N'dbo.query_audit_logs', N'U') IS NULL
  BEGIN
    CREATE TABLE dbo.query_audit_logs (
      audit_id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      occurred_at DATETIME2(3) NOT NULL DEFAULT GETDATE(),
      correlation_id NVARCHAR(128) NOT NULL,
      analysis_run_id NVARCHAR(128) NULL,
      user_id NVARCHAR(128) NULL,
      organization_id NVARCHAR(128) NULL,
      policy_version INT NULL,
      source_id NVARCHAR(128) NULL,
      object_ids_json NVARCHAR(MAX) NOT NULL DEFAULT N'[]',
      query_summary_json NVARCHAR(MAX) NOT NULL DEFAULT N'{}',
      parameters_summary_json NVARCHAR(MAX) NOT NULL DEFAULT N'{}',
      row_filter_injected BIT NOT NULL DEFAULT 0,
      outcome VARCHAR(16) NOT NULL,
      row_count BIGINT NULL,
      duration_ms INT NULL,
      rejection_reason NVARCHAR(512) NULL,
      error_code NVARCHAR(128) NULL
    );

    CREATE INDEX IX_query_audit_logs_occurred_at ON dbo.query_audit_logs (occurred_at DESC);
    CREATE INDEX IX_query_audit_logs_analysis_run_id ON dbo.query_audit_logs (analysis_run_id, occurred_at DESC);
    CREATE INDEX IX_query_audit_logs_source_id ON dbo.query_audit_logs (source_id, occurred_at DESC);
  END;

  INSERT INTO dbo.schema_migrations (migration_id)
  VALUES (N'001_initial_das_metadata_schema');
END;

COMMIT TRANSACTION;
