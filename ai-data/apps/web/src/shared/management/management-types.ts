import type { z } from "zod";
import type { Transport } from "../http/http-types";
import type { SessionResources } from "../session/session-resources";
/** 一页管理资源属于当前身份；重置必须包含表单中的秘密。 */
type ManagementDependencies = {
  request: Transport;
  resources: SessionResources;
  clear: () => void;
};
/** 不确定发布需要人工核对，公开信息不足以核实秘密内容。 */
type PublicationResult<T> = { status: "saved" | "conflict" | "uncertain"; current: T | null };
type PublicationOptions<T extends { version: number }> = {
  request: Transport;
  path: string;
  id: string;
  input: { version: number };
  schema: z.ZodType<T>;
  secret: boolean;
};
export type { ManagementDependencies, PublicationOptions, PublicationResult };
