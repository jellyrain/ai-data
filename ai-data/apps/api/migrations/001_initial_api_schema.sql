-- API 完整业务结构在首建事务中建立，多个实例通过事务级应用锁串行执行 DDL。
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
  SELECT 1 FROM dbo.schema_migrations WHERE migration_id = N'001_initial_api_schema'
)
BEGIN
    -- 组织是用户、会话和分析运行的归属边界。
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

    -- 同一组织内登录名唯一；本地密码保存派生摘要，授权版本随权限相关状态变化。
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

    -- 角色编码全局唯一，用户经由角色获取功能权限和常规数据范围。
    IF OBJECT_ID(N'dbo.roles', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.roles (id NVARCHAR(128) NOT NULL PRIMARY KEY, code NVARCHAR(128) NOT NULL UNIQUE, name NVARCHAR(256) NOT NULL, status NVARCHAR(32) NOT NULL DEFAULT 'active');
    END;
    -- 功能权限使用稳定编码，由角色与权限关联表分配。
    IF OBJECT_ID(N'dbo.permissions', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.permissions (id NVARCHAR(128) NOT NULL PRIMARY KEY, code NVARCHAR(256) NOT NULL UNIQUE, name NVARCHAR(256) NOT NULL);
    END;
    -- 用户与角色的多对多绑定，复合主键避免重复绑定。
    IF OBJECT_ID(N'dbo.user_roles', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.user_roles (user_id NVARCHAR(128) NOT NULL, role_id NVARCHAR(128) NOT NULL, PRIMARY KEY (user_id, role_id), FOREIGN KEY (user_id) REFERENCES dbo.users(id), FOREIGN KEY (role_id) REFERENCES dbo.roles(id));
    END;
    -- 角色与功能权限的多对多绑定。
    IF OBJECT_ID(N'dbo.role_permissions', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.role_permissions (role_id NVARCHAR(128) NOT NULL, permission_id NVARCHAR(128) NOT NULL, PRIMARY KEY (role_id, permission_id), FOREIGN KEY (role_id) REFERENCES dbo.roles(id), FOREIGN KEY (permission_id) REFERENCES dbo.permissions(id));
    END;
    -- 身份数据范围保存资源、字段、比较方式和文本值，由认证仓储转换为查询策略。
    IF OBJECT_ID(N'dbo.data_scopes', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.data_scopes (id NVARCHAR(128) NOT NULL PRIMARY KEY, resource NVARCHAR(256) NOT NULL, field NVARCHAR(256) NOT NULL, operator NVARCHAR(16) NOT NULL, value NVARCHAR(MAX) NOT NULL);
    END;
    IF OBJECT_ID(N'dbo.role_data_scopes', N'U') IS NULL
    BEGIN
      -- 将常规数据范围绑定到角色，认证仓储按用户的有效角色读取。
      CREATE TABLE dbo.role_data_scopes (role_id NVARCHAR(128) NOT NULL, data_scope_id NVARCHAR(128) NOT NULL, PRIMARY KEY (role_id, data_scope_id), FOREIGN KEY (role_id) REFERENCES dbo.roles(id), FOREIGN KEY (data_scope_id) REFERENCES dbo.data_scopes(id));
    END;
    IF OBJECT_ID(N'dbo.user_data_scopes', N'U') IS NULL
    BEGIN
      -- 保存用户例外范围，与角色范围一同参与身份策略加载。
      CREATE TABLE dbo.user_data_scopes (user_id NVARCHAR(128) NOT NULL, data_scope_id NVARCHAR(128) NOT NULL, PRIMARY KEY (user_id, data_scope_id), FOREIGN KEY (user_id) REFERENCES dbo.users(id), FOREIGN KEY (data_scope_id) REFERENCES dbo.data_scopes(id));
    END;
    -- 外部身份来源的配置记录，为认证来源扩展提供持久化位置。
    IF OBJECT_ID(N'dbo.identity_providers', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.identity_providers (id NVARCHAR(128) NOT NULL PRIMARY KEY, code NVARCHAR(128) NOT NULL UNIQUE, protocol NVARCHAR(32) NOT NULL, status NVARCHAR(32) NOT NULL DEFAULT 'active');
    END;
    -- 外部来源与主体组合唯一，映射到一个本地用户。
    IF OBJECT_ID(N'dbo.external_identities', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.external_identities (id NVARCHAR(128) NOT NULL PRIMARY KEY, provider NVARCHAR(128) NOT NULL, subject NVARCHAR(512) NOT NULL, user_id NVARCHAR(128) NOT NULL, UNIQUE (provider, subject), FOREIGN KEY (user_id) REFERENCES dbo.users(id));
    END;
    -- 刷新会话保存令牌摘要、轮换及撤销时间，原始令牌由客户端持有。
    IF OBJECT_ID(N'dbo.auth_sessions', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.auth_sessions (id NVARCHAR(128) NOT NULL PRIMARY KEY, user_id NVARCHAR(128) NOT NULL, refresh_token_hash CHAR(64) NOT NULL, expires_at DATETIME2(3) NOT NULL, rotated_at DATETIME2(3) NULL, revoked_at DATETIME2(3) NULL, created_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(), FOREIGN KEY (user_id) REFERENCES dbo.users(id));
    END;
    -- 会话同时绑定组织与用户，读取时由仓储按这两个归属字段过滤。
    IF OBJECT_ID(N'dbo.conversations', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.conversations (
        id NVARCHAR(128) NOT NULL PRIMARY KEY,
        organization_id NVARCHAR(128) NOT NULL,
        user_id NVARCHAR(128) NOT NULL,
        title NVARCHAR(512) NULL,
        status NVARCHAR(32) NOT NULL DEFAULT 'active',
        created_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        agent_id NVARCHAR(128) NULL,
        agent_version INT NULL,
        CONSTRAINT CK_conversations_agent_binding CHECK (
          (agent_id IS NULL AND agent_version IS NULL)
          OR (agent_id IS NOT NULL AND agent_version IS NOT NULL AND agent_version > 0)
        ),
        FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id),
        FOREIGN KEY (user_id) REFERENCES dbo.users(id)
      );
    END;
    -- 会话内消息序号唯一，由服务分配序号后写入。
    IF OBJECT_ID(N'dbo.conversation_messages', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.conversation_messages (
        id NVARCHAR(128) NOT NULL PRIMARY KEY,
        conversation_id NVARCHAR(128) NOT NULL,
        role NVARCHAR(32) NOT NULL,
        content NVARCHAR(MAX) NOT NULL,
        sequence INT NOT NULL,
        created_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        analysis_run_id NVARCHAR(128) NULL,
        UNIQUE (conversation_id, sequence),
        FOREIGN KEY (conversation_id) REFERENCES dbo.conversations(id)
      );
    END;
    -- 记录用户问题对应的分析运行归属、状态、时间和失败摘要。
    IF OBJECT_ID(N'dbo.analysis_runs', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.analysis_runs (
        id NVARCHAR(128) NOT NULL PRIMARY KEY,
        conversation_id NVARCHAR(128) NOT NULL,
        organization_id NVARCHAR(128) NOT NULL,
        user_id NVARCHAR(128) NOT NULL,
        status NVARCHAR(32) NOT NULL DEFAULT 'created',
        error_code NVARCHAR(128) NULL,
        error_message NVARCHAR(1024) NULL,
        started_at DATETIME2(3) NULL,
        completed_at DATETIME2(3) NULL,
        created_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        agent_id NVARCHAR(128) NULL,
        agent_version INT NULL,
        CONSTRAINT CK_analysis_runs_agent_binding CHECK (
          (agent_id IS NULL AND agent_version IS NULL)
          OR (agent_id IS NOT NULL AND agent_version IS NOT NULL AND agent_version > 0)
        ),
        FOREIGN KEY (conversation_id) REFERENCES dbo.conversations(id),
        FOREIGN KEY (organization_id) REFERENCES dbo.organizations(id),
        FOREIGN KEY (user_id) REFERENCES dbo.users(id)
      );
    END;
    -- API 保存心跳推导的回调地址与数据源健康快照，按最近接收时间发现可用实例。
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
      -- 保存 API 维护的业务说明、关系、统计规则、字段策略和查询能力配置，读取后与 DAS 目录结合。
      CREATE TABLE dbo.api_dataset_configs (
        source_id NVARCHAR(128) NOT NULL,
        object_id NVARCHAR(256) NOT NULL,
        config_json NVARCHAR(MAX) NOT NULL,
        version INT NOT NULL DEFAULT 1,
        updated_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
        PRIMARY KEY (source_id, object_id)
      );
    END;
    -- 按数据源、角色与对象保存访问决定。
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
    -- 按数据源、角色、对象和字段保存访问决定及可用操作列表。
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
    -- 每个角色在一个数据源对象上保存一条行过滤条件JSON。
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

    -- 部门标识对应业务数据源中的权限字段，由 API 管理员按用户维护。
    CREATE TABLE dbo.user_department_scopes (
      user_id NVARCHAR(128) NOT NULL,
      department_id NVARCHAR(128) NOT NULL,
      PRIMARY KEY (user_id, department_id),
      FOREIGN KEY (user_id) REFERENCES dbo.users(id)
    );

    -- 运行快照、事件、工具证据和幂等提交共同支持崩溃后的恢复。
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

    -- 指标和报告按组织、稳定标识及版本持久化，历史版本保存完整快照。
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

    -- 目录策略版本按组织与数据源递增，每次保存目标角色完整规则及变更审计。
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

    -- 调度记录与用户消息一起提交，工具摘要用于关联运行和证据。
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
    CREATE INDEX IX_analysis_runs_dispatch ON dbo.analysis_runs(status, created_at) INCLUDE(user_id,organization_id);

    -- 业务会话绑定官方线程，授权上下文变化时由 API 创建新的线程。
    CREATE TABLE dbo.analysis_codex_threads (
      conversation_id NVARCHAR(128) NOT NULL PRIMARY KEY REFERENCES dbo.conversations(id),
      thread_id NVARCHAR(128) NOT NULL,
      context_hash CHAR(64) NOT NULL,
      updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );

    -- Agent 当前状态与固定配置版本分开保存，会话及运行保留实际绑定版本。
    CREATE TABLE dbo.agents (
      organization_id NVARCHAR(128) NOT NULL REFERENCES dbo.organizations(id),
      agent_id NVARCHAR(128) NOT NULL,
      enabled BIT NOT NULL DEFAULT 1,
      PRIMARY KEY (organization_id,agent_id)
    );
    CREATE TABLE dbo.agent_definitions (
      organization_id NVARCHAR(128) NOT NULL,
      agent_id NVARCHAR(128) NOT NULL,
      version INT NOT NULL CHECK (version > 0),
      definition_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(definition_json)=1),
      skill_fingerprint NVARCHAR(64) NOT NULL,
      PRIMARY KEY (organization_id,agent_id,version),
      FOREIGN KEY (organization_id,agent_id) REFERENCES dbo.agents(organization_id,agent_id)
    );

    -- 模型公开配置与该版本的 AES-GCM 凭据密文在同一事务中写入元数据库。
    CREATE TABLE dbo.model_configurations (
      organization_id NVARCHAR(128) NOT NULL REFERENCES dbo.organizations(id),
      model_id NVARCHAR(128) NOT NULL,
      enabled BIT NOT NULL CONSTRAINT DF_model_configurations_enabled DEFAULT 1,
      CONSTRAINT PK_model_configurations PRIMARY KEY (organization_id, model_id)
    );
    CREATE TABLE dbo.model_configuration_versions (
      organization_id NVARCHAR(128) NOT NULL,
      model_id NVARCHAR(128) NOT NULL,
      version INT NOT NULL,
      definition_json NVARCHAR(MAX) NOT NULL,
      key_id NVARCHAR(128) NOT NULL,
      encrypted_payload VARBINARY(MAX) NOT NULL,
      encryption_metadata_json NVARCHAR(MAX) NOT NULL,
      CONSTRAINT PK_model_configuration_versions PRIMARY KEY (organization_id, model_id, version),
      CONSTRAINT FK_model_configuration_versions_model FOREIGN KEY (organization_id, model_id)
          REFERENCES dbo.model_configurations (organization_id, model_id),
      CONSTRAINT CK_model_configuration_versions_version CHECK (version > 0),
      CONSTRAINT CK_model_configuration_versions_json CHECK (ISJSON(definition_json) = 1),
      CONSTRAINT CK_model_configuration_versions_encryption_json CHECK (ISJSON(encryption_metadata_json) = 1)
    );

    -- 个人记忆按组织和账号保存，版本与幂等记录共同保护自动保存、确认和后台合并。
    CREATE TABLE dbo.user_preferences (
      organization_id NVARCHAR(128) NOT NULL REFERENCES dbo.organizations(id),
      user_id NVARCHAR(128) NOT NULL REFERENCES dbo.users(id),
      preference_key NVARCHAR(128) NOT NULL,
      version INT NOT NULL CHECK (version > 0),
      preference_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(preference_json) = 1),
      PRIMARY KEY (organization_id, user_id, preference_key)
    );
    CREATE TABLE dbo.preference_operations (
      organization_id NVARCHAR(128) NOT NULL,
      user_id NVARCHAR(128) NOT NULL,
      idempotency_key NVARCHAR(128) NOT NULL,
      request_hash CHAR(64) NOT NULL,
      result_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(result_json) = 1),
      PRIMARY KEY (organization_id, user_id, idempotency_key)
    );
    CREATE TABLE dbo.preference_confirmations (
      organization_id NVARCHAR(128) NOT NULL,
      user_id NVARCHAR(128) NOT NULL,
      confirmation_id NVARCHAR(128) NOT NULL,
      record_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(record_json) = 1),
      PRIMARY KEY (organization_id, user_id, confirmation_id)
    );
    CREATE TABLE dbo.preference_sources (
      organization_id NVARCHAR(128) NOT NULL,
      user_id NVARCHAR(128) NOT NULL,
      preference_key NVARCHAR(128) NOT NULL,
      source_hash CHAR(64) NOT NULL,
      source_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(source_json) = 1),
      PRIMARY KEY (organization_id, user_id, preference_key, source_hash)
    );
    CREATE TABLE dbo.preference_audits (
      audit_id NVARCHAR(128) NOT NULL PRIMARY KEY,
      organization_id NVARCHAR(128) NOT NULL,
      user_id NVARCHAR(128) NOT NULL,
      record_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(record_json) = 1)
    );

    -- 候选记录当前内容，来源及审核独立留痕；正式版本不可覆盖，启停由知识头管理。
    CREATE TABLE dbo.knowledge_candidates (
      organization_id NVARCHAR(128) NOT NULL REFERENCES dbo.organizations(id),
      candidate_id NVARCHAR(128) NOT NULL,
      version INT NOT NULL CHECK (version > 0),
      content_hash CHAR(64) NOT NULL,
      record_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(record_json) = 1),
      PRIMARY KEY (organization_id, candidate_id)
    );
    CREATE INDEX ix_knowledge_candidate_content ON dbo.knowledge_candidates(organization_id, content_hash);
    CREATE TABLE dbo.knowledge_sources (
      organization_id NVARCHAR(128) NOT NULL,
      candidate_id NVARCHAR(128) NOT NULL,
      source_hash CHAR(64) NOT NULL,
      user_id NVARCHAR(128) NOT NULL,
      source_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(source_json) = 1),
      PRIMARY KEY (organization_id, candidate_id, source_hash)
    );
    CREATE TABLE dbo.knowledge_reviews (
      organization_id NVARCHAR(128) NOT NULL,
      candidate_id NVARCHAR(128) NOT NULL,
      review_id NVARCHAR(128) NOT NULL,
      record_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(record_json) = 1),
      PRIMARY KEY (organization_id, candidate_id, review_id)
    );
    CREATE TABLE dbo.knowledge_heads (
      organization_id NVARCHAR(128) NOT NULL REFERENCES dbo.organizations(id),
      knowledge_id NVARCHAR(128) NOT NULL,
      enabled BIT NOT NULL DEFAULT 1,
      PRIMARY KEY (organization_id, knowledge_id)
    );
    CREATE TABLE dbo.knowledge_versions (
      organization_id NVARCHAR(128) NOT NULL,
      knowledge_id NVARCHAR(128) NOT NULL,
      version INT NOT NULL CHECK (version > 0),
      effective_at DATETIME2 NOT NULL,
      record_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(record_json) = 1),
      PRIMARY KEY (organization_id, knowledge_id, version),
      FOREIGN KEY (organization_id, knowledge_id) REFERENCES dbo.knowledge_heads(organization_id, knowledge_id)
    );
    CREATE TABLE dbo.knowledge_operations (
      organization_id NVARCHAR(128) NOT NULL,
      user_id NVARCHAR(128) NOT NULL,
      idempotency_key NVARCHAR(128) NOT NULL,
      request_hash CHAR(64) NOT NULL,
      result_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(result_json) = 1),
      PRIMARY KEY (organization_id, user_id, idempotency_key)
    );
    CREATE TABLE dbo.metric_publications (
      organization_id NVARCHAR(128) NOT NULL,
      metric_id NVARCHAR(128) NOT NULL,
      version INT NOT NULL,
      knowledge_id NVARCHAR(128) NOT NULL,
      knowledge_version INT NOT NULL,
      owner_user_id NVARCHAR(128) NOT NULL,
      effective_at DATETIME2 NOT NULL,
      published_at DATETIME2 NOT NULL,
      scope_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(scope_json) = 1),
      PRIMARY KEY (organization_id, metric_id, version),
      FOREIGN KEY (organization_id, metric_id, version) REFERENCES dbo.metric_definitions(organization_id, metric_id, version)
    );

    -- 工具先保存结构化意图，成功回答在同一事务入队；事件拥有独立的领取代次与重试预算。
    CREATE TABLE dbo.memory_intents (
      analysis_run_id NVARCHAR(128) NOT NULL REFERENCES dbo.analysis_runs(id),
      intent_key CHAR(64) NOT NULL,
      intent_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(intent_json) = 1),
      PRIMARY KEY (analysis_run_id, intent_key)
    );
    CREATE TABLE dbo.memory_events (
      event_id NVARCHAR(128) NOT NULL PRIMARY KEY,
      organization_id NVARCHAR(128) NOT NULL,
      user_id NVARCHAR(128) NOT NULL,
      session_id NVARCHAR(128) NOT NULL,
      analysis_run_id NVARCHAR(128) NOT NULL REFERENCES dbo.analysis_runs(id),
      intent_key CHAR(64) NOT NULL,
      intent_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(intent_json) = 1),
      status NVARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
      lease_owner NVARCHAR(128) NULL,
      lease_epoch INT NOT NULL DEFAULT 0,
      lease_expires_at DATETIME2 NULL,
      attempts INT NOT NULL DEFAULT 0,
      next_attempt_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
      created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
      updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
      last_error_code NVARCHAR(128) NULL,
      UNIQUE (analysis_run_id, intent_key)
    );
    CREATE INDEX ix_memory_events_pending ON dbo.memory_events(status, next_attempt_at, lease_expires_at);

    CREATE TABLE dbo.analysis_memory_contexts (
      analysis_run_id NVARCHAR(128) NOT NULL REFERENCES dbo.analysis_runs(id),
      lease_epoch INT NOT NULL,
      context_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(context_json)=1),
      PRIMARY KEY (analysis_run_id,lease_epoch)
    );

    -- 业务关系按来源对象保存唯一版本，配置 JSON 读取时由该表组装。
    CREATE TABLE dbo.approved_relations (
      source_id NVARCHAR(128) NOT NULL,
      object_id NVARCHAR(256) NOT NULL,
      relation_id NVARCHAR(128) NOT NULL,
      target_object_id NVARCHAR(256) NOT NULL,
      version INT NOT NULL CHECK (version > 0),
      enabled BIT NOT NULL,
      record_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(record_json)=1),
      PRIMARY KEY NONCLUSTERED (source_id, object_id, relation_id)
    );
    CREATE INDEX ix_relations_target ON dbo.approved_relations(source_id, target_object_id);
    -- 定义头记录用于并发锁和当前 ACL；历史版本保持不可变。
    CREATE TABLE dbo.report_templates (
      organization_id NVARCHAR(128) NOT NULL REFERENCES dbo.organizations(id),
      report_id NVARCHAR(128) NOT NULL,
      user_id NVARCHAR(128) NOT NULL REFERENCES dbo.users(id),
      version INT NOT NULL CHECK (version > 0),
      record_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(record_json)=1),
      created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
      updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
      PRIMARY KEY (organization_id, report_id)
    );
    CREATE INDEX ix_report_template_owner ON dbo.report_templates(organization_id, user_id, report_id);
    CREATE TABLE dbo.report_template_versions (
      organization_id NVARCHAR(128) NOT NULL,
      report_id NVARCHAR(128) NOT NULL,
      version INT NOT NULL CHECK (version > 0),
      record_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(record_json)=1),
      PRIMARY KEY (organization_id, report_id, version),
      FOREIGN KEY (organization_id, report_id) REFERENCES dbo.report_templates(organization_id, report_id)
    );
    CREATE TABLE dbo.report_blocks (
      organization_id NVARCHAR(128) NOT NULL REFERENCES dbo.organizations(id),
      block_id NVARCHAR(128) NOT NULL,
      user_id NVARCHAR(128) NOT NULL REFERENCES dbo.users(id),
      version INT NOT NULL CHECK (version > 0),
      record_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(record_json)=1),
      created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
      updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
      PRIMARY KEY (organization_id, block_id)
    );
    CREATE TABLE dbo.report_block_versions (
      organization_id NVARCHAR(128) NOT NULL,
      block_id NVARCHAR(128) NOT NULL,
      version INT NOT NULL CHECK (version > 0),
      record_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(record_json)=1),
      PRIMARY KEY (organization_id, block_id, version),
      FOREIGN KEY (organization_id, block_id) REFERENCES dbo.report_blocks(organization_id, block_id)
    );
    CREATE TABLE dbo.analysis_artifacts (
      organization_id NVARCHAR(128) NOT NULL,
      analysis_run_id NVARCHAR(128) NOT NULL REFERENCES dbo.analysis_runs(id),
      artifact_id NVARCHAR(128) NOT NULL,
      record_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(record_json)=1),
      PRIMARY KEY (organization_id, analysis_run_id, artifact_id)
    );
    CREATE INDEX ix_saved_reports_owner ON dbo.saved_reports(organization_id, user_id, report_id, version);
    -- 执行操作键由账号和报表共同隔离；运行终态和完整快照一次性提交。
    CREATE TABLE dbo.report_executions (
      organization_id NVARCHAR(128) NOT NULL,
      execution_id NVARCHAR(128) NOT NULL,
      report_id NVARCHAR(128) NOT NULL,
      user_id NVARCHAR(128) NOT NULL,
      idempotency_key NVARCHAR(128) NOT NULL,
      request_hash CHAR(64) NOT NULL,
      status NVARCHAR(32) NOT NULL CHECK (status IN ('running','completed','failed')),
      lease_epoch INT NOT NULL,
      deadline DATETIME2 NOT NULL,
      record_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(record_json)=1),
      PRIMARY KEY (organization_id, execution_id),
      UNIQUE (organization_id, user_id, report_id, idempotency_key)
    );
    CREATE INDEX ix_report_executions_report ON dbo.report_executions(organization_id, report_id, execution_id);
    CREATE TABLE dbo.analysis_report_contexts (
      analysis_run_id NVARCHAR(128) NOT NULL PRIMARY KEY REFERENCES dbo.analysis_runs(id),
      organization_id NVARCHAR(128) NOT NULL,
      user_id NVARCHAR(128) NOT NULL,
      report_id NVARCHAR(128) NOT NULL,
      expected_version INT NOT NULL,
      context_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(context_json)=1),
      staged_definition_json NVARCHAR(MAX) NULL CHECK (staged_definition_json IS NULL OR ISJSON(staged_definition_json)=1)
    );
    CREATE TABLE dbo.report_template_publications (
      organization_id NVARCHAR(128) NOT NULL,
      report_id NVARCHAR(128) NOT NULL,
      definition_version INT NOT NULL,
      knowledge_id NVARCHAR(128) NOT NULL,
      knowledge_version INT NOT NULL,
      definition_hash CHAR(64) NOT NULL,
      PRIMARY KEY (organization_id, knowledge_id, knowledge_version),
      FOREIGN KEY (organization_id, report_id, definition_version) REFERENCES dbo.report_template_versions(organization_id, report_id, version)
    );
    CREATE TABLE dbo.report_revision_requests (
      organization_id NVARCHAR(128) NOT NULL,
      user_id NVARCHAR(128) NOT NULL,
      report_id NVARCHAR(128) NOT NULL,
      idempotency_key NVARCHAR(128) NOT NULL,
      request_hash CHAR(64) NOT NULL,
      conversation_id NVARCHAR(128) NOT NULL,
      analysis_run_id NVARCHAR(128) NOT NULL REFERENCES dbo.analysis_runs(id),
      PRIMARY KEY NONCLUSTERED (organization_id, user_id, report_id, idempotency_key)
    );
    CREATE TABLE dbo.report_narratives (
      organization_id NVARCHAR(128) NOT NULL,
      execution_id NVARCHAR(128) NOT NULL,
      analysis_run_id NVARCHAR(128) NOT NULL,
      record_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(record_json)=1),
      PRIMARY KEY (organization_id, execution_id, analysis_run_id)
    );

    -- DDL 与迁移标记在同一事务提交，后续启动按标记跳过已应用迁移。
    INSERT INTO dbo.schema_migrations (migration_id)
    VALUES (N'001_initial_api_schema');
END;
COMMIT TRANSACTION;
