SET XACT_ABORT ON;
BEGIN TRANSACTION;

DECLARE @migration_lock_result INT;
EXEC @migration_lock_result = sp_getapplock
  @Resource = N'ai-bi-api:metadata-schema',
  @LockMode = N'Exclusive',
  @LockOwner = N'Transaction',
  @LockTimeout = 60000;

IF @migration_lock_result < 0
  THROW 51000, 'API metadata schema migration lock could not be acquired.', 1;

IF NOT EXISTS (
  SELECT 1 FROM dbo.schema_migrations WHERE migration_id = N'001_initial_auth_schema'
)
BEGIN
    IF OBJECT_ID(N'dbo.organizations', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.organizations (
        id NVARCHAR(128) NOT NULL PRIMARY KEY,
        code NVARCHAR(128) NOT NULL UNIQUE,
        name NVARCHAR(256) NOT NULL,
        status NVARCHAR(32) NOT NULL DEFAULT 'active',
        created_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME()
      );
    END;

    IF OBJECT_ID(N'dbo.users', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.users (
        id NVARCHAR(128) NOT NULL PRIMARY KEY,
        organization_id NVARCHAR(128) NOT NULL,
        username NVARCHAR(256) NOT NULL,
        display_name NVARCHAR(256) NOT NULL,
        password_hash NVARCHAR(512) NULL,
        status NVARCHAR(32) NOT NULL DEFAULT 'pending',
        authorization_version INT NOT NULL DEFAULT 1,
        last_login_at DATETIME2(3) NULL,
        created_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        CONSTRAINT uq_users_org_username UNIQUE (organization_id, username),
        CONSTRAINT fk_users_organization FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id)
      );
    END;

    IF OBJECT_ID(N'dbo.roles', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.roles (id NVARCHAR(128) NOT NULL PRIMARY KEY, code NVARCHAR(128) NOT NULL UNIQUE, name NVARCHAR(256) NOT NULL, status NVARCHAR(32) NOT NULL DEFAULT 'active');
    END;
    IF OBJECT_ID(N'dbo.permissions', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.permissions (id NVARCHAR(128) NOT NULL PRIMARY KEY, code NVARCHAR(256) NOT NULL UNIQUE, name NVARCHAR(256) NOT NULL);
    END;
    IF OBJECT_ID(N'dbo.user_roles', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.user_roles (user_id NVARCHAR(128) NOT NULL, role_id NVARCHAR(128) NOT NULL, PRIMARY KEY (user_id, role_id), FOREIGN KEY (user_id) REFERENCES dbo.users(id), FOREIGN KEY (role_id) REFERENCES dbo.roles(id));
    END;
    IF OBJECT_ID(N'dbo.role_permissions', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.role_permissions (role_id NVARCHAR(128) NOT NULL, permission_id NVARCHAR(128) NOT NULL, PRIMARY KEY (role_id, permission_id), FOREIGN KEY (role_id) REFERENCES dbo.roles(id), FOREIGN KEY (permission_id) REFERENCES dbo.permissions(id));
    END;
    IF OBJECT_ID(N'dbo.data_scopes', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.data_scopes (id NVARCHAR(128) NOT NULL PRIMARY KEY, resource NVARCHAR(256) NOT NULL, field NVARCHAR(256) NOT NULL, operator NVARCHAR(16) NOT NULL, value NVARCHAR(MAX) NOT NULL);
    END;
    IF OBJECT_ID(N'dbo.role_data_scopes', N'U') IS NULL
    BEGIN
      -- 常规数据范围绑定到角色，用户级绑定只保存经过批准的个别例外。
      CREATE TABLE dbo.role_data_scopes (role_id NVARCHAR(128) NOT NULL, data_scope_id NVARCHAR(128) NOT NULL, PRIMARY KEY (role_id, data_scope_id), FOREIGN KEY (role_id) REFERENCES dbo.roles(id), FOREIGN KEY (data_scope_id) REFERENCES dbo.data_scopes(id));
    END;
    IF OBJECT_ID(N'dbo.user_data_scopes', N'U') IS NULL
    BEGIN
      -- 仅保存经批准的用户个别例外；常规范围由 role_data_scopes 管理。
      CREATE TABLE dbo.user_data_scopes (user_id NVARCHAR(128) NOT NULL, data_scope_id NVARCHAR(128) NOT NULL, PRIMARY KEY (user_id, data_scope_id), FOREIGN KEY (user_id) REFERENCES dbo.users(id), FOREIGN KEY (data_scope_id) REFERENCES dbo.data_scopes(id));
    END;
    IF OBJECT_ID(N'dbo.identity_providers', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.identity_providers (id NVARCHAR(128) NOT NULL PRIMARY KEY, code NVARCHAR(128) NOT NULL UNIQUE, protocol NVARCHAR(32) NOT NULL, status NVARCHAR(32) NOT NULL DEFAULT 'active');
    END;
    IF OBJECT_ID(N'dbo.external_identities', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.external_identities (id NVARCHAR(128) NOT NULL PRIMARY KEY, provider NVARCHAR(128) NOT NULL, subject NVARCHAR(512) NOT NULL, user_id NVARCHAR(128) NOT NULL, UNIQUE (provider, subject), FOREIGN KEY (user_id) REFERENCES dbo.users(id));
    END;
    IF OBJECT_ID(N'dbo.auth_sessions', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.auth_sessions (id NVARCHAR(128) NOT NULL PRIMARY KEY, user_id NVARCHAR(128) NOT NULL, refresh_token_hash CHAR(64) NOT NULL, expires_at DATETIME2(3) NOT NULL, rotated_at DATETIME2(3) NULL, revoked_at DATETIME2(3) NULL, created_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(), FOREIGN KEY (user_id) REFERENCES dbo.users(id));
    END;
    IF OBJECT_ID(N'dbo.conversations', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.conversations (id NVARCHAR(128) NOT NULL PRIMARY KEY, organization_id NVARCHAR(128) NOT NULL, user_id NVARCHAR(128) NOT NULL, title NVARCHAR(512) NULL, status NVARCHAR(32) NOT NULL DEFAULT 'active', created_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(), updated_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(), FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id), FOREIGN KEY (user_id) REFERENCES dbo.users(id));
    END;
    IF OBJECT_ID(N'dbo.conversation_messages', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.conversation_messages (id NVARCHAR(128) NOT NULL PRIMARY KEY, conversation_id NVARCHAR(128) NOT NULL, role NVARCHAR(32) NOT NULL, content NVARCHAR(MAX) NOT NULL, sequence INT NOT NULL, created_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(), UNIQUE (conversation_id, sequence), FOREIGN KEY (conversation_id) REFERENCES dbo.conversations(id));
    END;
    IF OBJECT_ID(N'dbo.analysis_runs', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.analysis_runs (id NVARCHAR(128) NOT NULL PRIMARY KEY, conversation_id NVARCHAR(128) NOT NULL, organization_id NVARCHAR(128) NOT NULL, user_id NVARCHAR(128) NOT NULL, status NVARCHAR(32) NOT NULL DEFAULT 'created', error_code NVARCHAR(128) NULL, error_message NVARCHAR(1024) NULL, started_at DATETIME2(3) NULL, completed_at DATETIME2(3) NULL, created_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(), FOREIGN KEY (conversation_id) REFERENCES dbo.conversations(id), FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id), FOREIGN KEY (user_id) REFERENCES dbo.users(id));
    END;
    IF OBJECT_ID(N'dbo.data_access_services', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.data_access_services (
        service_id NVARCHAR(128) NOT NULL PRIMARY KEY,
        service_url NVARCHAR(2048) NOT NULL,
        service_version NVARCHAR(128) NULL,
        status NVARCHAR(32) NOT NULL,
        last_heartbeat_at DATETIME2(3) NOT NULL,
        message NVARCHAR(1024) NULL,
        sources_json NVARCHAR(MAX) NOT NULL
      );
    END;
    IF OBJECT_ID(N'dbo.api_dataset_configs', N'U') IS NULL
    BEGIN
      -- 物理目录由 DAS 提供；此表只保存 API 维护的业务说明和可用能力收窄配置。
      CREATE TABLE dbo.api_dataset_configs (
        source_id NVARCHAR(128) NOT NULL,
        object_id NVARCHAR(256) NOT NULL,
        config_json NVARCHAR(MAX) NOT NULL,
        updated_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        PRIMARY KEY (source_id, object_id)
      );
    END;
    IF OBJECT_ID(N'dbo.role_object_permissions', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.role_object_permissions (
        source_id NVARCHAR(128) NOT NULL,
        role_id NVARCHAR(128) NOT NULL,
        object_id NVARCHAR(256) NOT NULL,
        effect NVARCHAR(16) NOT NULL,
        PRIMARY KEY (source_id, role_id, object_id),
        FOREIGN KEY (role_id) REFERENCES dbo.roles(id)
      );
    END;
    IF OBJECT_ID(N'dbo.role_column_permissions', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.role_column_permissions (
        source_id NVARCHAR(128) NOT NULL,
        role_id NVARCHAR(128) NOT NULL,
        object_id NVARCHAR(256) NOT NULL,
        column_name NVARCHAR(256) NOT NULL,
        effect NVARCHAR(16) NOT NULL,
        operations_json NVARCHAR(MAX) NULL,
        PRIMARY KEY (source_id, role_id, object_id, column_name),
        FOREIGN KEY (role_id) REFERENCES dbo.roles(id)
      );
    END;
    IF OBJECT_ID(N'dbo.role_row_policies', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.role_row_policies (
        source_id NVARCHAR(128) NOT NULL,
        role_id NVARCHAR(128) NOT NULL,
        object_id NVARCHAR(256) NOT NULL,
        condition_json NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (source_id, role_id, object_id),
        FOREIGN KEY (role_id) REFERENCES dbo.roles(id)
      );
    END;

    INSERT INTO dbo.schema_migrations (migration_id)
    VALUES (N'001_initial_auth_schema');
END;
COMMIT TRANSACTION;
