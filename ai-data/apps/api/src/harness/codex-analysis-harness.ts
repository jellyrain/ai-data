import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { z } from "zod";
import { stableStringify } from "@ai-data/contracts";
import { ApplicationError } from "../errors/application-error";
import { CodexAppServer, resolveCodexCommand } from "./codex-app-server";
import { CodexSessionRouter } from "./codex-session-router";
import type { CodexCommand } from "./codex-app-server-types";
import type {
  AnalysisHarness,
  CodexHarnessOptions,
  HarnessRequest,
  HarnessResult,
  CodexModelProviderConfig,
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
  private admission = Promise.resolve();
  private readonly executing = new Set<Promise<HarnessResult>>();
  private readonly providers = new Map<string, CodexModelProviderConfig>();

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
    if (provider?.apiKey) env.AI_DATA_MODEL_API_KEY = provider.apiKey;
    for (const [key, configured] of this.providers) {
      if (configured.apiKey) env[`AI_DATA_${key}_KEY`] = configured.apiKey;
      Object.entries(configured.headers ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([, value], index) => {
          env[`AI_DATA_${key}_HEADER_${index}`] = value;
        });
    }
    const config: Record<string, string | number | boolean | string[]> = {
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
      "features.apps": false,
      "features.plugins": false,
      web_search: "disabled",
    };
    if (provider)
      Object.assign(config, {
        model_provider: "analysis_provider",
        "model_providers.analysis_provider.name": provider.id,
        "model_providers.analysis_provider.base_url": provider.baseUrl,
        "model_providers.analysis_provider.wire_api": "responses",
        "model_providers.analysis_provider.request_max_retries": 0,
        "model_providers.analysis_provider.stream_max_retries": 0,
        "model_providers.analysis_provider.stream_idle_timeout_ms":
          this.options.timeoutMs ?? 180000,
      });
    if (provider?.apiKey)
      config["model_providers.analysis_provider.env_key"] = "AI_DATA_MODEL_API_KEY";
    Object.entries(provider?.headers ?? {}).forEach(([name, value], index) => {
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
        if (
          ![
            "turn/started",
            "turn/completed",
            "item/started",
            "item/completed",
            "item/agentMessage/delta",
          ].includes(method)
        )
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
    // 入场顺序保证添加环境认证时先排空旧进程；已注册提供方的轮次仍可并发。
    const admitted = this.admission.then(async () => {
      const assertAdmission = () => {
        if (this.closed || request.signal.aborted)
          throw new ApplicationError("CANCELLED", "分析已取消");
      };
      assertAdmission();
      const provider = request.configuration?.provider;
      const key = provider && this.providerKey(provider);
      if (provider && key && !this.providers.has(key)) {
        await Promise.allSettled(this.executing);
        await this.starting;
        assertAdmission();
        this.providers.set(key, provider);
        if (this.client)
          this.retire(this.client, new ApplicationError("CANCELLED", "模型认证配置更新"));
        await this.retiring;
      }
      assertAdmission();
      const running = this.execute(request).finally(() => {
        this.executing.delete(running);
      });
      this.executing.add(running);
      return { running };
    });
    this.admission = admitted.then(
      () => {},
      () => {},
    );
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new ApplicationError("CANCELLED", "分析已取消"));
      request.signal.addEventListener("abort", abort, { once: true });
    });
    const task = Promise.race([admitted, cancelled])
      .then(({ running }) => {
        request.signal.removeEventListener("abort", abort);
        return running;
      })
      .finally(() => {
        request.signal.removeEventListener("abort", abort);
        this.active.delete(request.sessionKey);
      });
    this.active.set(request.sessionKey, task);
    return task;
  }

  /** 凭据变化形成新的进程环境槽位；旧配置仍可用于已绑定会话。 */
  private providerKey(provider: CodexModelProviderConfig): string {
    return `provider_${createHash("sha256").update(stableStringify(provider)).digest("hex")}`;
  }

  private providerSettings(provider: CodexModelProviderConfig, timeoutMs: number) {
    const key = this.providerKey(provider);
    return {
      name: provider.id,
      base_url: provider.baseUrl,
      wire_api: "responses",
      request_max_retries: 0,
      stream_max_retries: 0,
      stream_idle_timeout_ms: timeoutMs,
      ...(provider.apiKey ? { env_key: `AI_DATA_${key}_KEY` } : {}),
      env_http_headers: Object.fromEntries(
        Object.keys(provider.headers ?? {})
          .sort((a, b) => a.localeCompare(b))
          .map((name, index) => [name, `AI_DATA_${key}_HEADER_${index}`]),
      ),
    };
  }

  private async execute(request: HarnessRequest): Promise<HarnessResult> {
    const provider = request.configuration?.provider ?? this.options.provider;
    if (!provider) throw new ApplicationError("INVALID_INPUT", "当前运行未绑定模型配置");
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
      request.configuration?.timeoutMs ?? this.options.timeoutMs ?? 180000,
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
      const configured = request.configuration;
      const cwd = configured?.cwd ?? resolve(this.options.stateDirectory, "work", scope);
      await mkdir(cwd, { recursive: true });
      assertActive();
      const configuration: Record<string, unknown> = {};
      let skills = this.skillInputs;
      if (configured) {
        const providerKey = this.providerKey(provider);
        configuration[`model_providers.${providerKey}`] = this.providerSettings(
          provider,
          configured.timeoutMs,
        );
        skills = configured.skills.names.map((name) => ({
          type: "skill",
          name,
          path: join(cwd, ".agents", "skills", name, "SKILL.md"),
        }));
        const allowed = new Set(skills.map((skill) => resolve(skill.path)));
        const listed = record(
          await client.request("skills/list", { cwds: [cwd], forceReload: true }),
        );
        const discovered = z
          .array(z.object({ skills: z.array(z.object({ path: z.string() })) }))
          .parse(listed.data)
          .flatMap((entry) => entry.skills);
        configuration["skills.config"] = discovered.map((skill) => ({
          path: skill.path,
          enabled: allowed.has(resolve(skill.path)),
        }));
      }
      const contextWindow = configured ? configured.contextWindow : this.options.contextWindow;
      if (contextWindow) {
        configuration.model_context_window = contextWindow;
        configuration.model_auto_compact_token_limit =
          (configured ? configured.autoCompactTokenLimit : this.options.autoCompactTokenLimit) ??
          Math.floor(contextWindow * 0.75);
      }
      const settings = {
        model: provider.model,
        modelProvider: configured ? this.providerKey(provider) : "analysis_provider",
        cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        baseInstructions: request.instructions,
        config: configuration,
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
        input: [{ type: "text", text: request.input }, ...(request.threadId ? [] : skills)],
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
