import { normalizeBoard } from "./board.ts";
import type { Board, Constraints, DecideInput, FailedTest, Reading } from "./types.ts";

const DEFAULT_ORIGIN = "http://127.0.0.1:4321";

type Loose = Record<string, unknown>;

export function fixtrOrigin(): string {
  const raw = process.env.FIXTR_URL?.trim() || DEFAULT_ORIGIN;
  const url = new URL(raw);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    throw new Error("Fixtr client only calls http://127.0.0.1 or http://localhost.");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

export async function getSession(id: string): Promise<unknown> {
  return getJson(`/api/sessions/${encodeURIComponent(id)}`);
}

export async function getBoard(id: string): Promise<Board> {
  return normalizeBoard(await getJson(`/api/sessions/${encodeURIComponent(id)}/board`));
}

export async function getExport(id: string): Promise<unknown> {
  return getJson(`/api/sessions/${encodeURIComponent(id)}/export.json`);
}

/** Session, board, and export.json, shaped as one decide() input. */
export async function loadDecideInput(id: string): Promise<DecideInput> {
  const [session, boardPayload, exported] = await Promise.all([
    getSession(id).catch(() => null),
    getBoard(id).catch(() => null),
    getExport(id).catch(() => null),
  ]);
  if (!session && !boardPayload && !exported) {
    throw new Error(`No Fixtr session ${id} at ${fixtrOrigin()}.`);
  }
  const board = boardPayload && boardPayload.pads.length > 0
    ? boardPayload
    : normalizeBoard(pick(exported, "board") ?? pick(session, "board") ?? exported);
  return {
    symptom: firstString(session, exported, ["symptom", "issue", "problem", "complaint", "title"]) ?? "",
    board,
    readings: readReadings(session, exported),
    hypotheses: arrayField(session, exported, "hypotheses"),
    evidence: stringArray(session, exported, "evidence"),
    constraints: objectField(session, exported, "constraints") as Constraints | undefined,
    failedTest: objectField(session, exported, "failedTest") as FailedTest | undefined,
  };
}

async function getJson(path: string): Promise<unknown> {
  const url = `${fixtrOrigin()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch {
    throw new Error(`Fixtr is not running at ${fixtrOrigin()}.`);
  }
  if (!response.ok) throw new Error(`Fixtr ${path} returned ${response.status}.`);
  return response.json();
}

function asRecord(value: unknown): Loose | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Loose;
  return null;
}

function pick(value: unknown, key: string): unknown {
  return asRecord(value)?.[key];
}

function firstString(session: unknown, exported: unknown, keys: string[]): string | undefined {
  for (const source of [session, exported]) {
    const rec = asRecord(source);
    if (!rec) continue;
    for (const key of keys) {
      const value = rec[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    const issue = asRecord(rec.issue);
    if (issue) {
      for (const key of keys) {
        const value = issue[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  }
  return undefined;
}

function readReadings(session: unknown, exported: unknown): Reading[] {
  for (const source of [session, exported]) {
    const rec = asRecord(source);
    const list = rec?.readings ?? rec?.measurements;
    if (!Array.isArray(list)) continue;
    const readings: Reading[] = [];
    for (const item of list) {
      const row = asRecord(item);
      if (!row) continue;
      const value = typeof row.value === "number" ? row.value : Number(row.value);
      if (!Number.isFinite(value)) continue;
      const reading: Reading = { value };
      if (typeof row.target === "string") reading.target = row.target;
      if (typeof row.net === "string") reading.net = row.net;
      if (typeof row.unit === "string") reading.unit = row.unit;
      readings.push(reading);
    }
    if (readings.length > 0) return readings;
  }
  return [];
}

function arrayField(session: unknown, exported: unknown, key: string): DecideInput["hypotheses"] {
  for (const source of [session, exported]) {
    const value = pick(source, key);
    if (Array.isArray(value)) return value as DecideInput["hypotheses"];
  }
  return undefined;
}

function stringArray(session: unknown, exported: unknown, key: string): string[] | undefined {
  for (const source of [session, exported]) {
    const value = pick(source, key);
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value as string[];
  }
  return undefined;
}

function objectField(session: unknown, exported: unknown, key: string): Loose | undefined {
  for (const source of [session, exported]) {
    const value = asRecord(pick(source, key));
    if (value) return value;
  }
  return undefined;
}
