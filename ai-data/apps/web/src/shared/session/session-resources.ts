/** 当前身份拥有的可取消请求和业务资源。 */
class SessionResources {
  private controllers = new Set<AbortController>();
  private cleanups = new Set<() => void>();
  register(cleanup: () => void): () => void {
    this.cleanups.add(cleanup);
    return () => this.cleanups.delete(cleanup);
  }
  async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return await operation(controller.signal);
    } finally {
      this.controllers.delete(controller);
    }
  }
  reset(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    for (const cleanup of this.cleanups) cleanup();
  }
}

export { SessionResources };
