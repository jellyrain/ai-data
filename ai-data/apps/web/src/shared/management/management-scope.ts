import { shallowReactive } from "vue";
import { ZodError } from "zod";
import { ApiError } from "../http/api-error";
import type { Transport } from "../http/http-types";
import type { ManagementDependencies } from "./management-types";

/** 请求逐次核对代次，身份清理后任何 await 都不能继续提交旧页面状态。 */
class ManagementScope {
  readonly state = shallowReactive({ busy: false, error: "", notice: "" });
  private generation = 0;
  private controller = new AbortController();
  private unregister: () => void;
  constructor(private readonly dependencies: ManagementDependencies) {
    this.unregister = dependencies.resources.register(() => this.clear());
  }
  clear() {
    this.generation++;
    this.controller.abort();
    this.controller = new AbortController();
    this.dependencies.clear();
    Object.assign(this.state, { busy: false, error: "", notice: "" });
  }
  dispose() {
    this.unregister();
    this.clear();
  }
  async run(operation: (request: Transport) => Promise<unknown>): Promise<void> {
    if (this.state.busy) return;
    const generation = this.generation;
    const controller = this.controller;
    const current = () => generation === this.generation && !controller.signal.aborted;
    const request: Transport = async (path, options) => {
      if (!current()) throw new ApiError("操作已取消", 0, "CANCELLED");
      const result = await this.dependencies.request(path, {
        ...options,
        signal: options?.signal
          ? AbortSignal.any([controller.signal, options.signal])
          : controller.signal,
      });
      if (!current()) throw new ApiError("操作已取消", 0, "CANCELLED");
      return result;
    };
    Object.assign(this.state, { busy: true, error: "", notice: "" });
    try {
      await operation(request);
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && [401, 403].includes(error.status))
        this.dependencies.resources.reset();
      this.state.error =
        error instanceof ZodError
          ? error.issues
              .map((issue) => `${issue.path.join(".")}：${issue.message}`)
              .slice(0, 5)
              .join("；")
          : error instanceof ApiError
            ? `${error.message}${error.requestId ? `（请求 ${error.requestId}）` : ""}`
            : "操作失败，请检查输入或稍后重试";
    } finally {
      if (current()) this.state.busy = false;
    }
  }
}
export { ManagementScope };
