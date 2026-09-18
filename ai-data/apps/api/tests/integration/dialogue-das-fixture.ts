import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { createServer } from "node:net";
import type { MetadataConnectionConfig } from "@ai-data/metadata";
import type { JwtService } from "../../src/auth/jwt-service";
import { DataAccessManagementClient } from "../../src/data-access/data-access-management-client";
import { HttpDataAccessCatalogClient } from "../../src/data-access/data-access-catalog-client";

/** 通过已构建的 DAS 进程验收生产 HTTP、目录发现、查询规划和 SQL 驱动。 */
class DialogueDasFixture {
  readonly serviceId = "dialogue-das";
  private directory?: string;
  private child?: ChildProcess;
  private exited?: Promise<void>;
  private startupFailure?: string;
  serviceUrl = "";

  async start(connection: MetadataConnectionConfig, publicKey: string): Promise<void> {
    const port = await availablePort();
    this.serviceUrl = `http://127.0.0.1:${port}`;
    const source = fileURLToPath(new URL("../../../data-access/", import.meta.url));
    this.directory = mkdtempSync(join(tmpdir(), "ai-data-dialogue-"));
    const directory = this.directory;
    mkdirSync(join(directory, "dist"));
    mkdirSync(join(directory, "config"));
    copyFileSync(join(source, "dist/index.js"), join(directory, "dist/index.mjs"));
    cpSync(join(source, "migrations"), join(directory, "migrations"), { recursive: true });
    symlinkSync(join(source, "node_modules"), join(directory, "node_modules"), "junction");
    writeFileSync(join(directory, "config/api-public.pem"), publicKey);
    writeFileSync(join(directory, "config/registration.txt"), "dialogue-fixture-registration");
    writeFileSync(
      join(directory, "config/das.config.json"),
      JSON.stringify({
        service: {
          host: "127.0.0.1",
          port,
          service_id: this.serviceId,
          service_version: "integration",
        },
        api: {
          base_url: "http://127.0.0.1:1",
          heartbeat_path: "/heartbeat",
          registration_credential_path: "registration.txt",
          jwt_verification_public_key_path: "api-public.pem",
        },
        metadata_sqlserver: connection,
        sqlserver_transports: {
          dialogue: {
            encrypt: connection.options.encrypt,
            trust_server_certificate: connection.options.trust_server_certificate,
          },
        },
      }),
    );
    this.child = spawn(process.execPath, [join(directory, "dist/index.mjs")], {
      cwd: directory,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      const message = chunk.toString();
      if (message.includes("Dynamic require")) this.startupFailure = "DAS bundle 的依赖加载失败";
      if (message.includes("DAS 启动失败")) this.startupFailure = "DAS 构建进程启动失败";
      const failure = message.match(/^(?:[A-Za-z]*Error|Error \[[A-Z_]+\]):[^\r\n]{1,300}$/m)?.[0];
      if (failure)
        this.startupFailure = [connection.password, connection.user, connection.server].reduce(
          (summary, secret) => summary.replaceAll(secret, "[redacted]"),
          failure,
        );
    });
    this.child.on("error", () => {
      this.startupFailure = "DAS 子进程无法创建";
    });
    this.exited = new Promise((done) => this.child!.once("exit", () => done()));
    for (let attempt = 0; attempt < 150; attempt++) {
      if (this.startupFailure || this.child.exitCode !== null)
        throw new Error(this.startupFailure ?? "DAS 子进程提前退出");
      try {
        const response = await fetch(`${this.serviceUrl}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) return;
      } catch {
        /* 监听前连接失败，继续等待本轮进程。 */
      }
      await setTimeout(200);
    }
    throw new Error("DAS 子进程在 30 秒内未就绪");
  }

  async expose(connection: MetadataConnectionConfig, jwt: JwtService) {
    const management = new DataAccessManagementClient(jwt);
    await management.execute(this.serviceId, this.serviceUrl, "data-source-secrets", {
      secret_ref: "dialogue",
      connector_kind: "sqlserver",
      host: connection.server,
      port: connection.port,
      user: connection.user,
      password: connection.password,
    });
    await management.execute(this.serviceId, this.serviceUrl, "data-sources", {
      source_id: "dialogue",
      connector_kind: "sqlserver",
      secret_ref: "dialogue",
      target_database: connection.database,
      timeout_ms: 10000,
      connection_pool_limit: 2,
      concurrency_limit: 2,
      row_limit: 100,
    });
    await management.execute(this.serviceId, this.serviceUrl, "data-source-objects", {
      source_id: "dialogue",
      objects: [{ object_id: "table.dbo.dialogue_visits" }],
    });
    return new HttpDataAccessCatalogClient(jwt);
  }

  async close(): Promise<void> {
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
      await this.exited;
    }
    if (this.directory) {
      const absolute = resolve(this.directory);
      if (
        dirname(absolute) !== resolve(tmpdir()) ||
        !basename(absolute).startsWith("ai-data-dialogue-")
      )
        throw new Error("DAS 测试临时目录范围无效");
      rmSync(absolute, { recursive: true, force: true });
    }
  }
}

/** 动态分配本机监听端口，避免验收依赖正在运行的服务端口。 */
async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("未取得 DAS 测试端口");
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

/** 仅从本地配置读取 SQL 连接，调用方将数据库名替换为本轮隔离库。 */
function readDialogueConnection(): unknown {
  const path =
    process.env.SQLSERVER_TEST_CONFIG ??
    fileURLToPath(new URL("../../config/api.config.json", import.meta.url));
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return raw.metadata_sqlserver ?? raw;
}

export { DialogueDasFixture, readDialogueConnection };
