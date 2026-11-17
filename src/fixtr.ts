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
  const handoff = runResults(session) ? latestFailure(session) : latestFailure(exported);
  const readings = readReadings(session, exported);
  if (handoff?.reading) readings.unshift(handoff.reading);
  const reported = firstString(session, exported, ["symptom", "issue", "problem", "complaint", "title"]) ?? "";
  return {
    symptom: handoff ? joinSymptom(handoff.failedTest.name, issueText(session) ?? issueText(exported)) || reported : reported,
    board,
    readings,
    hypotheses: arrayField(session, exported, "hypotheses"),
    evidence: stringArray(session, exported, "evidence"),
    constraints: objectField(session, exported, "constraints") as Constraints | undefined,
    failedTest: handoff?.failedTest ?? (objectField(session, exported, "failedTest") as FailedTest | undefined),
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

type FailureHandoff = {
  failedTest: FailedTest;
  reading?: Reading;
};

function runResults(source: unknown): Loose | null {
  return asRecord(asRecord(pick(source, "run"))?.results);
}

/** The failed planned test an investigation should start from, latest `at` first. */
function latestFailure(source: unknown): FailureHandoff | null {
  const results = runResults(source);
  if (!results) return null;
  const tests = planTests(source);
  const fails: Array<{ id: string; result: Loose; at: number | null; order: number; entry: number }> = [];
  let entry = 0;
  for (const [key, value] of Object.entries(results)) {
    entry += 1;
    const result = asRecord(value);
    if (!result || stringOf(result.status).toLowerCase() !== "fail") continue;
    const id = key.trim();
    if (!id) continue;
    const order = tests.findIndex((test) => testId(test) === id);
    fails.push({ id, result, at: timeOf(result.at), order, entry });
  }
  if (fails.length === 0) return null;
  fails.sort((a, b) => {
    if (a.at !== null && b.at !== null && a.at !== b.at) return b.at - a.at;
    if ((a.at === null) !== (b.at === null)) return a.at === null ? 1 : -1;
    if (a.order !== b.order) return b.order - a.order;
    return b.entry - a.entry;
  });
  const chosen = fails[0];
  if (!chosen) return null;
  const test = tests.find((item) => testId(item) === chosen.id);
  return failureHandoff(chosen.id, test, chosen.result);
}

function planTests(source: unknown): Loose[] {
  const tests = asRecord(pick(source, "plan"))?.tests;
  if (!Array.isArray(tests)) return [];
  return tests.filter((item): item is Loose => asRecord(item) !== null);
}

function testId(test: Loose): string {
  if (typeof test.id === "number" && Number.isFinite(test.id)) return String(test.id);
  return stringOf(test.id);
}

function failureHandoff(id: string, test: Loose | undefined, result: Loose): FailureHandoff {
  const failedTest: FailedTest = { id };
  const name = stringOf(test?.name);
  if (name) failedTest.name = name;
  const description = stringOf(test?.description);
  const purpose = stringOf(test?.purpose);
  const method = stringOf(test?.method);
  const checked = description || purpose || method;
  if (checked) failedTest.checked = checked;
  if (description) failedTest.description = description;
  if (purpose) failedTest.purpose = purpose;
  const pass = passWindow(test?.pass);
  if (pass) {
    failedTest.pass = pass;
    if (pass.min !== undefined) failedTest.min = pass.min;
    if (pass.max !== undefined) failedTest.max = pass.max;
    if (pass.unit) failedTest.unit = pass.unit;
  }
  const probe = firstProbe(test);
  if (probe?.target) failedTest.target = probe.target;
  if (probe?.net) failedTest.net = probe.net;
  const measured = measuredValue(result.measured);
  if (measured) {
    failedTest.measured = measured.value;
    if (!failedTest.unit && measured.unit) failedTest.unit = measured.unit;
  } else {
    const raw = stringOf(result.measured);
    if (raw) failedTest.measured = raw;
  }
  const reading = measured ? readingFrom(failedTest, measured.value) : undefined;
  return { failedTest, reading };
}

function passWindow(value: unknown): FailedTest["pass"] | undefined {
  const pass = asRecord(value);
  if (!pass) return undefined;
  const window: NonNullable<FailedTest["pass"]> = {};
  const min = finiteNumber(pass.min);
  const max = finiteNumber(pass.max);
  if (min !== undefined) window.min = min;
  if (max !== undefined) window.max = max;
  const unit = stringOf(pass.unit);
  const text = stringOf(pass.text);
  if (unit) window.unit = unit;
  if (text) window.text = text;
  return min !== undefined || max !== undefined || unit || text ? window : undefined;
}

function firstProbe(test: Loose | undefined): { target?: string; net?: string } | undefined {
  const probes = test?.probes;
  if (!Array.isArray(probes)) return undefined;
  for (const item of probes) {
    const row = asRecord(item);
    if (!row) continue;
    const target = stringOf(row.target);
    const net = stringOf(row.net);
    if (target || net) return { ...(target ? { target } : {}), ...(net ? { net } : {}) };
  }
  return undefined;
}

function readingFrom(failed: FailedTest, value: number): Reading {
  const reading: Reading = { value };
  if (failed.target) reading.target = failed.target;
  if (failed.net) reading.net = failed.net;
  if (failed.unit) reading.unit = failed.unit;
  return reading;
}

function issueText(source: unknown): string | undefined {
  const issue = pick(source, "issue");
  return typeof issue === "string" && issue.trim() ? issue.trim() : undefined;
}

function joinSymptom(name: string | undefined, issue: string | undefined): string {
  const left = name?.trim() ?? "";
  const right = issue?.trim() ?? "";
  if (left && right && left.toLowerCase() !== right.toLowerCase()) return `${left}. ${right}`;
  return left || right;
}

function measuredValue(value: unknown): { value: number; unit?: string } | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? { value } : undefined;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([a-zA-ZΩμµ%]+)?$/i);
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return undefined;
  const unit = match[2]?.trim();
  return unit ? { value: parsed, unit } : { value: parsed };
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function timeOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const stamp = Date.parse(trimmed);
  return Number.isFinite(stamp) ? stamp : null;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
