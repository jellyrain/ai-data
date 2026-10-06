import type { z } from "zod";
import type { authContextSchema, loginInputSchema, userSchema } from "./auth-schema";
import type { Transport } from "../../../shared/http/http-types";

/** 登录提交的前端合同。 */
type LoginInput = z.infer<typeof loginInputSchema>;
/** 已由 API 确认的当前身份。 */
type AuthContext = z.infer<typeof authContextSchema>;
/** 用于页头展示的用户摘要。 */
type AuthUser = z.infer<typeof userSchema>;
/** 身份初始化、可用、失败及退出状态。 */
type AuthStatus =
  "idle" | "restoring" | "authenticated" | "anonymous" | "error" | "logging-out" | "logout-error";
/** 跨标签页仅同步身份变化通知。 */
type AuthEvent = "changed" | "logout";
/** 可替换的认证基础设施，便于验证刷新竞态。 */
type AuthDependencies = {
  transport: Transport;
  reset: () => void;
  coordinate: <T>(operation: () => Promise<T>) => Promise<T>;
  publish?: (event: AuthEvent) => void;
};

export type { LoginInput, AuthContext, AuthUser, AuthStatus, AuthEvent, AuthDependencies };
