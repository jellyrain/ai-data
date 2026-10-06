import { shallowReactive } from "vue";
import { ApiError } from "../../../shared/http/api-error";
import { authContextSchema, loginInputSchema, loginResultSchema } from "../api/auth-schema";
import type {
  AuthContext,
  AuthDependencies,
  AuthEvent,
  AuthStatus,
  AuthUser,
  LoginInput,
} from "../api/auth-types";

/** 以身份代次拒绝迟到结果；Cookie 操作共用同源锁。 */
class AuthSession {
  readonly state = shallowReactive<{
    status: AuthStatus;
    user: AuthUser | null;
    context: AuthContext | null;
    error: ApiError | null;
  }>({
    status: "idle",
    user: null,
    context: null,
    error: null,
  });
  private token = "";
  private epoch = 0;
  private restoring?: Promise<void>;
  private loggingIn?: Promise<void>;
  private loggingOut?: Promise<void>;
  private refreshing?: { epoch: number; task: Promise<void> };

  constructor(private readonly dependencies: AuthDependencies) {}

  private assertCurrent(epoch: number): void {
    if (epoch !== this.epoch) throw new ApiError("身份已变化，请重新操作", 0, "STALE_SESSION");
  }

  private clear(): void {
    this.epoch++;
    this.token = "";
    this.refreshing = undefined;
    this.restoring = undefined;
    Object.assign(this.state, { status: "anonymous", user: null, context: null, error: null });
    this.dependencies.reset();
  }

  private expire(epoch: number): void {
    if (epoch !== this.epoch) return;
    this.clear();
    this.dependencies.publish?.("logout");
  }

  private error(error: unknown): ApiError {
    return error instanceof ApiError
      ? error
      : new ApiError("身份响应格式异常，请稍后重试", 0, "INVALID_RESPONSE");
  }

  /** 在 token 与 me 身份一致后一次性提交状态。 */
  private async accept(
    raw: unknown,
    epoch: number,
    status: AuthStatus = "authenticated",
  ): Promise<void> {
    this.assertCurrent(epoch);
    const result = loginResultSchema.parse(raw);
    const context = authContextSchema.parse(
      await this.dependencies.transport("/auth/me", { token: result.accessToken }),
    );
    this.assertCurrent(epoch);
    if (
      context.userId !== result.user.id ||
      context.organizationId !== result.user.organizationId ||
      (this.state.context &&
        (context.userId !== this.state.context.userId ||
          context.organizationId !== this.state.context.organizationId ||
          context.sessionId !== this.state.context.sessionId))
    ) {
      throw new ApiError("登录身份发生变化，请重新登录", 401, "INVALID_RESPONSE");
    }
    this.token = result.accessToken;
    Object.assign(this.state, { status, user: result.user, context, error: null });
  }

  login(input: LoginInput): Promise<void> {
    if (this.loggingIn) return this.loggingIn;
    const credentials = loginInputSchema.parse(input);
    this.clear();
    const epoch = this.epoch;
    const task = this.dependencies
      .coordinate(async () => {
        this.assertCurrent(epoch);
        await this.accept(
          await this.dependencies.transport("/auth/login", { method: "POST", body: credentials }),
          epoch,
        );
        this.dependencies.publish?.("changed");
      })
      .catch((error) => {
        if (epoch === this.epoch) {
          this.clear();
          this.state.error = this.error(error);
        }
        throw this.error(error);
      })
      .finally(() => {
        if (this.loggingIn === task) this.loggingIn = undefined;
      });
    this.loggingIn = task;
    return task;
  }

  restore(): Promise<void> {
    if (this.restoring) return this.restoring;
    if (["authenticated", "anonymous", "logging-out", "logout-error"].includes(this.state.status))
      return Promise.resolve();
    this.state.status = "restoring";
    this.state.error = null;
    const epoch = this.epoch;
    const task = this.refresh(epoch)
      .catch((error) => {
        if (epoch !== this.epoch) return;
        const failure = this.error(error);
        if (failure.status === 401) this.clear();
        else {
          this.state.status = "error";
          this.state.error = failure;
        }
      })
      .finally(() => {
        if (this.restoring === task) this.restoring = undefined;
      });
    this.restoring = task;
    return task;
  }

  private refresh(epoch: number): Promise<void> {
    if (this.refreshing?.epoch === epoch) return this.refreshing.task;
    const task = this.dependencies
      .coordinate(async () => {
        this.assertCurrent(epoch);
        await this.accept(
          await this.dependencies.transport("/auth/refresh", { method: "POST", body: {} }),
          epoch,
        );
      })
      .finally(() => {
        if (this.refreshing?.task === task) this.refreshing = undefined;
      });
    this.refreshing = { epoch, task };
    return task;
  }

  /** 只重放明确被认证边界拒绝的请求，每个原请求最多一次。 */
  async request<T>(send: (token: string) => Promise<T>): Promise<T> {
    if (!this.token || this.state.status !== "authenticated")
      throw new ApiError("请先登录", 401, "AUTHENTICATION_FAILED");
    const epoch = this.epoch;
    const usedToken = this.token;
    try {
      const value = await send(usedToken);
      this.assertCurrent(epoch);
      return value;
    } catch (error) {
      this.assertCurrent(epoch);
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    }
    try {
      if (usedToken === this.token) await this.refresh(epoch);
      this.assertCurrent(epoch);
      const value = await send(this.token);
      this.assertCurrent(epoch);
      return value;
    } catch (error) {
      this.assertCurrent(epoch);
      if (error instanceof ApiError && error.status === 401) this.expire(epoch);
      throw this.error(error);
    }
  }

  logout(): Promise<void> {
    if (this.loggingOut) return this.loggingOut;
    if (!this.token) {
      this.clear();
      this.dependencies.publish?.("logout");
      return Promise.resolve();
    }
    this.epoch++;
    this.dependencies.reset();
    this.refreshing = undefined;
    const epoch = this.epoch;
    this.state.status = "logging-out";
    this.state.error = null;
    const task = this.dependencies
      .coordinate(async () => {
        this.assertCurrent(epoch);
        try {
          await this.dependencies.transport("/auth/logout", { method: "POST", token: this.token });
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 401) throw error;
          await this.accept(
            await this.dependencies.transport("/auth/refresh", { method: "POST", body: {} }),
            epoch,
            "logging-out",
          );
          await this.dependencies.transport("/auth/logout", { method: "POST", token: this.token });
        }
        this.assertCurrent(epoch);
        this.expire(epoch);
      })
      .catch((error) => {
        if (epoch !== this.epoch) return;
        const failure = this.error(error);
        if (failure.status === 401) {
          this.expire(epoch);
          return;
        }
        this.state.status = "logout-error";
        this.state.error = failure;
        throw failure;
      })
      .finally(() => {
        if (this.loggingOut === task) this.loggingOut = undefined;
      });
    this.loggingOut = task;
    return task;
  }

  async receive(event: AuthEvent): Promise<void> {
    this.clear();
    if (event === "changed") {
      this.state.status = "idle";
      await this.restore();
    }
  }
}

export { AuthSession };
