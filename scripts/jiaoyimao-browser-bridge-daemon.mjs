import readline from "node:readline";
import { claimJiaoyimaoBrowserJob } from "./jiaoyimao-browser-bridge.mjs";

const apiBaseUrl = "http://127.0.0.1:4310";

function safeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "bridge_error",
    message:
      typeof error?.message === "string"
        ? error.message
        : "交易猫浏览器任务操作失败"
  };
}

const createdResponse = await fetch(
  `${apiBaseUrl}/api/sources/jiaoyimao/browser-refresh`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  }
);
const created = await createdResponse.json();
if (!createdResponse.ok) {
  throw new Error(created?.message ?? "创建交易猫浏览器任务失败");
}

const client = await claimJiaoyimaoBrowserJob({
  jobId: created.jobId,
  claimCode: created.claimCode,
  baseUrl: apiBaseUrl
});

if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}

process.stdout.write(
  `${JSON.stringify({ ready: true, jobId: created.jobId })}\n`
);

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false
});

for await (const line of lines) {
  if (!line.trim()) continue;
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "invalid_command" } })}\n`
    );
    continue;
  }
  const id = command.id ?? null;
  const method = command.method;
  if (typeof method !== "string" || typeof client[method] !== "function") {
    process.stdout.write(
      `${JSON.stringify({ id, ok: false, error: { code: "invalid_method" } })}\n`
    );
    continue;
  }
  try {
    const result = await client[method](command.input);
    process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ id, ok: false, error: safeError(error) })}\n`
    );
  }
}
