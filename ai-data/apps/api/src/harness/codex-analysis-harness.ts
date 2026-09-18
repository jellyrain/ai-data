import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { z } from "zod";
import { ApplicationError } from "../errors/application-error";
import { CodexAppServer, resolveCodexCommand } from "./codex-app-server";
import { CodexSessionRouter } from "./codex-session-router";
import type { CodexCommand } from "./codex-app-server-types";
import type {
  AnalysisHarness,
  CodexHarnessOptions,
  HarnessRequest,
  HarnessResult,
} from "./harness-types";

const record = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);

/** 一个 API 实例管理一个官方进程；业务执行分别绑定线程和轮次。 */
class CodexAnalysisHarness implements AnalysisHarness {
  private client?: CodexAppServer;
  private starting?: Promise<void>;
  private retiring = Promise.resolve();
  private closing?: Promise<void>;
  private closed = false;
  private readonly sessions = new Map<string, CodexSessionRouter>();
  private readonly active = new Map<string, Promise<HarnessResult>>();
  private readonly skillInputs: { type: "skill"; name: string; path: string }[] = [];

  constructor(
    private readonly options: CodexHarnessOptions,
    private readonly dependencies: { command?: CodexCommand } = {},
  ) {}

  /** 初始化合并为单个在途操作，进程退出后的并发请求也只重建一次。 */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new ApplicationError("CANCELLED", "Codex 运行时已关闭"));
    if (this.starting) return this.starting;
    if (this.client) return Promise.resolve();
    this.starting = this.initialize().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async initialize(): Promise<void> {
    await this.retiring;
    const home = resolve(this.options.stateDirectory, "home");
    const work = resolve(this.options.stateDirectory, "work");
    const temp = resolve(this.options.stateDirectory, "tmp");
    const logs = resolve(this.options.stateDirectory, "logs");
    await Promise.all([home, work, temp, logs].map((path) => mkdir(path, { recursive: true })));
    this.skillInputs.length = 0;
    if (this.options.skills) {
      await this.options.skills.copyTo(join(home, "skills"));
      for (const name of this.options.skills.names) {
        const path = join(home, "skills", name, "SKILL.md");
        this.skillInputs.push({ type: "skill", name, path });
      }
    }
    const provider = this.options.provider;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          ["PATH", "SYSTEMROOT", "WINDIR"].includes(entry[0].toUpperCase()),
      ),
    );
    Object.assign(env, {
      CODEX_HOME: home,
      HOME: home,
      USERPROFILE: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "share"),
    });
    if (provider.apiKey) env.AI_DATA_MODEL_API_KEY = provider.apiKey;
    const config: Record<string, string | number | boolean | string[]> = {
      model_provider: "analysis_provider",
      "model_providers.analysis_provider.name": provider.id,
      "model_providers.analysis_provider.base_url": provider.baseUrl,
      "model_providers.analysis_provider.wire_api": "responses",
      "model_providers.analysis_provider.request_max_retries": 0,
      "model_providers.analysis_provider.stream_max_retries": 0,
      "model_providers.analysis_provider.stream_idle_timeout_ms": this.options.timeoutMs,
      check_for_update_on_startup: false,
      project_root_markers: [],
      project_doc_max_bytes: 0,
      log_dir: logs,
      sqlite_home: home,
      // 共享运行目录中的跨线程记忆不能替代业务权限隔离。
      "memories.generate_memories": false,
      "memories.use_memories": false,
      "features.shell_tool": false,
      "features.apply_patch_freeform": false,
      "features.multi_agent": false,
      "features.goals": false,
      "features.view_image": false,
      "features.image_generation": false,
      "features.skill_mcp_dependency_install": false,
      web_search: "disabled",
    };
    if (provider.apiKey)
      config["model_providers.analysis_provider.env_key"] = "AI_DATA_MODEL_API_KEY";
    if (this.options.contextWindow) config.model_context_window = this.options.contextWindow;
    Object.entries(provider.headers ?? {}).forEach(([name, value], index) => {
      const key = `AI_DATA_MODEL_HEADER_${index}`;
      env[key] = value;
      config[`model_providers.analysis_provider.env_http_headers.${JSON.stringify(name)}`] = key;
    });
    if (this.closed) throw new ApplicationError("CANCELLED", "Codex 运行时已关闭");
    const command = this.dependencies.command ?? resolveCodexCommand();
    const client = new CodexAppServer({
      command: {
        executable: command.executable,
        args: [
          ...command.args,
          ...Object.entries(config).flatMap(([key, value]) => [
            "-c",
            `${key}=${JSON.stringify(value)}`,
          ]),
        ],
      },
      env,
      cwd: work,
      onFailure: (error) => this.retire(client, error),
      onRequest: async (method, params) => {
        const value = record(params);
        const session =
          typeof value.threadId === "string" ? this.sessions.get(value.threadId) : undefined;
        if (!session) throw new ApplicationError("INTERNAL_ERROR", "Codex 请求未绑定业务运行");
        return session.call(method, params);
      },
      onNotification: (method, params) => {
        if (!["turn/started", "turn/completed", "item/started", "item/completed"].includes(method))
          return;
        const value = record(params);
        if (typeof value.threadId === "string")
          this.sessions.get(value.threadId)?.notify(method, params);
      },
    });
    this.client = client;
    try {
      await client.request("initialize", {
        clientInfo: { name: "ai_data_api", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
      client.notify("initialized");
    } catch (error) {
      this.retire(client, error instanceof Error ? error : new Error("Codex 初始化失败"));
      await this.retiring;
      throw error;
    }
  }

  private retire(client: CodexAppServer, error: Error): void {
    if (this.client !== client) return;
    this.client = undefined;
    for (const session of this.sessions.values()) session.disconnected(error);
    this.sessions.clear();
    this.retiring = client.close();
  }

  run(request: HarnessRequest): Promise<HarnessResult> {
    if (this.closed || request.signal.aborted)
      return Promise.reject(new ApplicationError("CANCELLED", "分析已取消"));
    if (this.active.has(request.sessionKey))
      return Promise.reject(new ApplicationError("CONFLICT", "当前会话已有分析执行"));
    const task = this.execute(request).finally(() => {
      this.active.delete(request.sessionKey);
    });
    this.active.set(request.sessionKey, task);
    return task;
  }

  private async execute(request: HarnessRequest): Promise<HarnessResult> {
    let session: CodexSessionRouter | undefined;
    let client: CodexAppServer | undefined;
    let stopped = false;
    let rejectInterruption!: (error: Error) => void;
    const interruption = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject;
    });
    const cancel = (error = new ApplicationError("CANCELLED", "分析已取消")) => {
      stopped = true;
      session?.fail(error);
      rejectInterruption(error);
    };
    const onAbort = () => cancel();
    const timer = setTimeout(
      () => cancel(new ApplicationError("QUERY_TIMEOUT", "分析运行超时")),
      this.options.timeoutMs,
    );
    request.signal.addEventListener("abort", onAbort, { once: true });
    const assertActive = () => {
      if (stopped || this.closed || request.signal.aborted)
        throw new ApplicationError("CANCELLED", "分析已停止");
    };
    const prepare = (async () => {
      await this.start();
      assertActive();
      client = this.client;
      if (!client) throw new ApplicationError("INTERNAL_ERROR", "Codex 运行时已退出");
      if (request.threadId && this.sessions.has(request.threadId))
        throw new ApplicationError("CONFLICT", "官方线程仍有未结束轮次");
      const scope = createHash("sha256").update(request.sessionKey).digest("hex");
      const cwd = resolve(this.options.stateDirectory, "work", scope);
      await mkdir(cwd, { recursive: true });
      assertActive();
      const settings = {
        model: this.options.provider.model,
        modelProvider: "analysis_provider",
        cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        baseInstructions: request.instructions,
      };
      const result = await client.request(
        request.threadId ? "thread/resume" : "thread/start",
        request.threadId
          ? { ...settings, threadId: request.threadId }
          : {
              ...settings,
              dynamicTools: request.tools.map((tool) => ({ type: "function", ...tool })),
            },
      );
      const threadId = z
        .string()
        .min(1)
        .parse(record(record(result).thread).id);
      if (request.threadId && threadId !== request.threadId)
        throw new ApplicationError("INTERNAL_ERROR", "Codex 返回的线程不匹配");
      if (this.sessions.has(threadId)) throw new ApplicationError("CONFLICT", "官方线程已绑定运行");
      session = new CodexSessionRouter(threadId, request);
      this.sessions.set(threadId, session);
      assertActive();
      await request.onThreadStarted(threadId);
      assertActive();
      const started = await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: request.input }, ...this.skillInputs],
      });
      session.bindTurn(record(record(started).turn).id);
    })();
    try {
      return await Promise.race([prepare.then(() => session!.result), interruption]);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("INTERNAL_ERROR", "模型服务暂时无法完成分析");
    } finally {
      stopped = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      // 若取消发生在 turn/start 响应前，先取得轮次标识再中断，避免遗留后台生成。
      await prepare.catch(() => {});
      if (session && client) {
        await session.interrupt(client);
        const finished = session;
        const release = () => {
          if (this.sessions.get(finished.threadId) === finished)
            this.sessions.delete(finished.threadId);
        };
        if (!session.turnId || session.nativeEnded) release();
        else void session.completion.then(release);
      }
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const session of this.sessions.values())
      session.fail(new ApplicationError("CANCELLED", "API 正在关闭"));
    this.closing = (async () => {
      await this.starting?.catch(() => {});
      await Promise.allSettled(this.active.values());
      if (this.client) this.retire(this.client, new ApplicationError("CANCELLED", "API 正在关闭"));
      await this.retiring;
    })();
    return this.closing;
  }
}
export { CodexAnalysisHarness };
