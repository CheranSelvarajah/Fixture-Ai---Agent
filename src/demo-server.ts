import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { cannedPresentationStep, presentationDecide } from "./demo.ts";
import type { DecideInput } from "./types.ts";

/** Port for the presentation demo. FIXTR_AGENT_URL uses this host and port. */
export function demoPort(): number {
  const parsed = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return 8787;
  return parsed;
}

/** Value Noah sets as FIXTR_AGENT_URL. The hook appends /decide. */
export function fixtrAgentUrl(port = demoPort()): string {
  return `http://127.0.0.1:${port}`;
}

export function createDemoServer() {
  return createServer((req, res) => {
    void handle(req, res);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url?.split("?")[0] ?? "";
  if (req.method === "GET" && url === "/health") {
    send(res, 200, { ok: true, canned: canned() });
    return;
  }
  if (req.method !== "POST" || (url !== "/decide" && url !== "/decide/")) {
    send(res, 404, { error: "POST /decide" });
    return;
  }
  try {
    const text = await readBody(req);
    const body = text.trim() ? JSON.parse(text) as Partial<DecideInput> : {};
    const step = canned() ? cannedPresentationStep(body) : await presentationDecide(body);
    send(res, 200, step);
  } catch (error) {
    const message = error instanceof Error ? error.message : "decide failed";
    send(res, 400, { error: message });
  }
}

function canned(): boolean {
  return process.env.DEMO_CANNED?.trim() === "1";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const json = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
  const port = demoPort();
  createDemoServer().listen(port, "127.0.0.1", () => {
    console.log(`FIXTR_AGENT_URL=${fixtrAgentUrl(port)}`);
  });
}
