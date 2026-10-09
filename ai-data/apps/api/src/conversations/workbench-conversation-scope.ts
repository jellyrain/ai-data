/** 别名 c 指向会话；报表创建与关联写入同一事务，历史记录也按真实关联归类。 */
const workbenchConversationScope = `
  NOT EXISTS (
    SELECT 1 FROM dbo.report_revision_requests rr
    WHERE rr.conversation_id=c.id AND rr.organization_id=c.organization_id
  ) AND NOT EXISTS (
    SELECT 1 FROM dbo.analysis_runs ar
    JOIN dbo.analysis_report_contexts rc ON rc.analysis_run_id=ar.id
    WHERE ar.conversation_id=c.id AND rc.organization_id=c.organization_id
  ) AND NOT EXISTS (
    SELECT 1 FROM dbo.analysis_runs ar
    JOIN dbo.report_executions re ON JSON_VALUE(re.record_json,'$.analysis_run_id')=ar.id
    WHERE ar.conversation_id=c.id AND re.organization_id=c.organization_id
  )`;
export { workbenchConversationScope };
