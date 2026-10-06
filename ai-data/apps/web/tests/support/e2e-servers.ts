import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { createServer } from "node:net";

/** 先确认测试端口空闲，避免把已有服务当成隔离测试服务。 */
async function requireFreePort(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
  });
}
/** 等待本次启动的进程就绪；退出和超时都保留服务输出。 */
async function waitReady(child: ChildProcess, url: string, logs: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`测试服务启动失败：${logs()}`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(800) })).ok) return;
    } catch {
      /* 等待服务监听。 */
    }
    await setTimeout(150);
  }
  throw new Error(`测试服务就绪超时：${url}\n${logs()}`);
}
/** 直接持有 Node 子进程，跨平台关闭自身进程，不依赖 Windows 进程树枚举。 */
async function setup(): Promise<() => Promise<void>> {
  const web = fileURLToPath(new URL("../../", import.meta.url));
  const api = fileURLToPath(new URL("../../../api/", import.meta.url));
  const children: ChildProcess[] = [];
  const stop = async () => {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once("exit", () => {
              clearTimeout(force);
              resolve();
            });
            const force = globalThis.setTimeout(() => child.kill("SIGKILL"), 3000);
            child.kill("SIGTERM");
          }),
      ),
    );
  };
  try {
    await requireFreePort(4318);
    await requireFreePort(5317);
    for (const service of [
      {
        cwd: api,
        args: ["--import", "tsx", "tests/support/web-auth-server.ts"],
        url: "http://127.0.0.1:4318/health",
      },
      {
        cwd: web,
        args: [
          "node_modules/vite/bin/vite.js",
          ...(process.env.WEB_E2E_PREVIEW === "1" ? ["preview"] : []),
          "--host",
          "127.0.0.1",
          "--port",
          "5317",
          "--strictPort",
        ],
        url: "http://127.0.0.1:5317",
      },
    ]) {
      const child = spawn(process.execPath, service.args, {
        cwd: service.cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          WEB_AUTH_TEST_PORT: "4318",
          WEB_API_TARGET: "http://127.0.0.1:4318",
        },
      });
      children.push(child);
      let logs = "";
      child.stdout?.on("data", (chunk) => {
        logs = (logs + String(chunk)).slice(-4000);
      });
      child.stderr?.on("data", (chunk) => {
        logs = (logs + String(chunk)).slice(-4000);
      });
      child.on("error", (error) => {
        logs += error.message;
      });
      await waitReady(child, service.url, () => logs);
    }
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}
export default setup;
