import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { decide } from "./decide.ts";
import { loadDecideInput } from "./fixtr.ts";
import type { DecideInput } from "./types.ts";

const PORT = Number(process.env.PORT ?? 8787);

export function createDecideServer() {
  return createServer((req, res) => {
    void handle(req, res);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET" && req.url === "/health") {
    send(res, 200, { ok: true });
    return;
  }
  if (req.method !== "POST" || (req.url !== "/decide" && req.url !== "/decide/")) {
    send(res, 404, { error: "POST /decide" });
    return;
  }
  try {
    const body = JSON.parse(await readBody(req)) as DecideInput & { sessionId?: string };
    const input = body.sessionId && !body.board ? await loadDecideInput(body.sessionId) : body;
    send(res, 200, await decide(input));
  } catch (error) {
    const message = error instanceof Error ? error.message : "decide failed";
    send(res, 400, { error: message });
  }
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

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  createDecideServer().listen(PORT, "127.0.0.1", () => {
    console.log(`debug agent listening on http://127.0.0.1:${PORT}/decide`);
  });
}
