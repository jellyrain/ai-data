-- 在目标 API 数据库中执行；与完整首建采用同一应用锁，只新增附件结构。
SET XACT_ABORT ON;
BEGIN TRANSACTION;
DECLARE @attachment_lock INT;
EXEC @attachment_lock = sp_getapplock @Resource=N'ai-bi-api:metadata-schema', @LockMode=N'Exclusive', @LockOwner=N'Transaction', @LockTimeout=60000;
IF @attachment_lock < 0 THROW 51000, 'Attachment schema lock failed.', 1;
IF OBJECT_ID(N'dbo.conversation_attachments', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.conversation_attachments (
    id NVARCHAR(128) NOT NULL PRIMARY KEY,
    conversation_id NVARCHAR(128) NOT NULL REFERENCES dbo.conversations(id),
    name NVARCHAR(255) NOT NULL,
    mime_type NVARCHAR(32) NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
    size_bytes INT NOT NULL CHECK (size_bytes>0 AND size_bytes<=10485760),
    width INT NOT NULL CHECK (width BETWEEN 1 AND 8192),
    height INT NOT NULL CHECK (height BETWEEN 1 AND 8192),
    sha256 CHAR(64) NOT NULL,
    status NVARCHAR(16) NOT NULL CHECK (status IN ('pending','attached','deleted')),
    created_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    expires_at DATETIME2(3) NULL,
    CONSTRAINT ck_conversation_attachment_pixels CHECK (CAST(width AS BIGINT)*height<=20000000)
  );
  CREATE INDEX ix_conversation_attachments_conversation ON dbo.conversation_attachments(conversation_id,status);
  CREATE INDEX ix_conversation_attachments_expiry ON dbo.conversation_attachments(status,expires_at);
END;
IF OBJECT_ID(N'dbo.conversation_message_attachments', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.conversation_message_attachments (
    message_id NVARCHAR(128) NOT NULL REFERENCES dbo.conversation_messages(id),
    attachment_id NVARCHAR(128) NOT NULL REFERENCES dbo.conversation_attachments(id),
    position INT NOT NULL CHECK (position BETWEEN 0 AND 3),
    PRIMARY KEY (message_id,position),
    CONSTRAINT uq_conversation_message_attachment UNIQUE (attachment_id)
  );
END;
COMMIT TRANSACTION;
