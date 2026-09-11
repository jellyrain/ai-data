import type { AuthContext } from "./auth-types";

/** 进程内缓存的一条身份上下文及其失效时间。 */
type CacheEntry = {
  /** 已通过会话和权限版本校验的身份上下文。 */
  context: AuthContext;
  /** 缓存失效时间戳，单位为毫秒。 */
  expiresAt: number;
};

/** 进程内身份上下文缓存；部署到多实例时替换为共享缓存实现。 */
class AuthContextCache {
  private readonly entries = new Map<string, CacheEntry>();
  constructor(private readonly ttlMilliseconds = 60_000) {}
  /** 读取未过期的会话身份上下文。 */
  get(sessionId: string): AuthContext | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(sessionId);
      return null;
    }
    return entry.context;
  }
  /** 写入会话身份上下文并设置过期时间。 */
  set(sessionId: string, context: AuthContext): void {
    this.entries.set(sessionId, { context, expiresAt: Date.now() + this.ttlMilliseconds });
  }
  /** 删除指定会话的身份上下文。 */
  delete(sessionId: string): void {
    this.entries.delete(sessionId);
  }
  /** 删除指定用户的全部身份上下文。 */
  deleteUser(userId: string): void {
    for (const [sessionId, entry] of this.entries) {
      if (entry.context.userId === userId) this.entries.delete(sessionId);
    }
  }
}

export { AuthContextCache };
