import type { AuthContext } from "./auth-types";

/** 进程内缓存的一条身份上下文及其失效时间。 */
type CacheEntry = {
  /** 写入时已由认证服务加载的身份与权限快照。 */
  context: AuthContext;
  /** 缓存失效时间戳，单位为毫秒。 */
  expiresAt: number;
};

/** 单实例身份上下文缓存，默认存活 60 秒；主动失效只作用于当前进程。 */
class AuthContextCache {
  private readonly entries = new Map<string, CacheEntry>();
  constructor(private readonly ttlMilliseconds = 60_000) {}
  /** 读取会话快照；过期条目在本次读取时移除。 */
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
