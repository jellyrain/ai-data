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

IF OBJECT_ID(N'dbo.schema_migrations', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.schema_migrations (
    migration_id NVARCHAR(128) NOT NULL PRIMARY KEY,
    applied_at DATETIME2(3) NOT NULL DEFAULT GETDATE()
  );
END;

COMMIT TRANSACTION;
