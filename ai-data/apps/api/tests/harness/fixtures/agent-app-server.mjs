import { createInterface } from "node:readline";
import process from "node:process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const threads = new Map();
const calls = new Map();
let sequence = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "skills/list") {
    send({
      id: message.id,
      result: {
        data: message.params.cwds.map((cwd) => ({
          cwd,
          skills: [
            ...readdirSync(join(cwd, ".agents/skills")).map((name) => ({
              name,
              path: join(cwd, ".agents/skills", name, "SKILL.md"),
            })),
            { name: "unbound", path: join(process.env.CODEX_HOME, "skills/unbound/SKILL.md") },
          ],
        })),
      },
    });
  }
  if (["thread/start", "thread/resume"].includes(message.method)) {
    const id = message.params.threadId ?? `thread-${process.pid}-${++sequence}`;
    threads.set(id, message.params);
    send({ id: message.id, result: { thread: { id } } });
  }
  if (message.method === "turn/start") {
    const threadId = message.params.threadId,
      turnId = `turn-${++sequence}`,
      id = `call-${sequence}`;
    const settings = threads.get(threadId);
    const provider = settings.config?.[`model_providers.${settings.modelProvider}`];
    calls.set(id, { threadId, turnId });
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
    send({
      id,
      method: "item/tool/call",
      params: {
        threadId,
        turnId,
        callId: id,
        tool: "echo",
        arguments: {
          pid: process.pid,
          settings,
          skills: message.params.input.filter((item) => item.type === "skill"),
          apiKey: provider ? process.env[provider.env_key] : undefined,
        },
      },
    });
  }
  if (calls.has(message.id)) {
    const { threadId, turnId } = calls.get(message.id);
    calls.delete(message.id);
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { type: "agentMessage", text: message.result.contentItems[0].text },
      },
    });
    send({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed", error: null } },
    });
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId: message.params.threadId,
        turn: { id: message.params.turnId, status: "interrupted", error: null },
      },
    });
  }
});
