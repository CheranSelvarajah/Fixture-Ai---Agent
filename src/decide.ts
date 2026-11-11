import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { findPad, nets, normalizeBoard, targetOf } from "./board.ts";
import { scriptedStep } from "./scripted.ts";
import type { ActionType, DecideInput, Hypothesis, HypothesisStatus, NextAction, ProbeKind, ProbeLead, Reading, Step } from "./types.ts";

const PLAYBOOK_URL = new URL("./playbook.md", import.meta.url);

const STATUSES = new Set<HypothesisStatus>(["active", "ruled_out", "confirmed"]);
const ACTIONS = new Set<ActionType>(["probe", "command", "reflash", "physical", "question"]);
const LEADS = new Set<ProbeLead>(["red", "black"]);
const KINDS = new Set<ProbeKind>(["probe", "connector", "button", "pin1"]);
const CLASSES = new Set(["hardware", "firmware", "plan", "setup", "unknown"]);

/**
 * One turn in, one step out.
 * SB_AI=mock (the default) follows the playbook in-process and does not use an API key.
 * SB_AI=live sends the playbook plus this turn to the model, then the same safety check.
 */
export async function decide(raw: DecideInput): Promise<Step> {
  const input = normalizeInput(raw);
  const mode = (process.env.SB_AI ?? "mock").trim().toLowerCase();
  if (mode === "mock" || mode === "") return polish(scriptedStep(input), input);
  const drafted = await modelStep(input);
  return polish(drafted, input);
}

export function normalizeInput(raw: DecideInput): DecideInput {
  const readings = [...(raw.readings ?? [])];
  if (raw.reading) readings.push(raw.reading);
  return {
    symptom: typeof raw.symptom === "string" ? raw.symptom : "",
    board: normalizeBoard(raw.board),
    readings: readings.map(normalizeReading).filter((item): item is Reading => item !== null),
    hypotheses: raw.hypotheses,
    evidence: raw.evidence,
    constraints: raw.constraints,
    failedTest: raw.failedTest,
  };
}

function normalizeReading(raw: Reading): Reading | null {
  const value = typeof raw.value === "number" ? raw.value : Number(raw.value);
  if (!Number.isFinite(value)) return null;
  const reading: Reading = { value };
  if (typeof raw.target === "string" && raw.target.trim()) reading.target = raw.target.trim();
  if (typeof raw.net === "string" && raw.net.trim()) reading.net = raw.net.trim();
  if (typeof raw.unit === "string" && raw.unit.trim()) reading.unit = raw.unit.trim();
  return reading;
}

async function modelStep(input: DecideInput): Promise<Step> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new Error("SB_AI=live needs ANTHROPIC_API_KEY. SB_AI=mock runs the playbook with no key.");
  const playbook = readFileSync(fileURLToPath(PLAYBOOK_URL), "utf8");
  const model = process.env.SB_MODEL?.trim() || "claude-sonnet-4-5";
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      messages: [{
        role: "user",
        content: `${playbook}\n\nReturn one JSON object for this turn. No markdown.\n\n${JSON.stringify(input)}`,
      }],
    }),
  });
  if (!response.ok) throw new Error(`Model request failed (${response.status}).`);
  const payload = await response.json() as { content?: Array<{ type?: string; text?: string }> };
  const text = (payload.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
  return parseStep(text);
}

function parseStep(text: string): Step {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Model did not return a step object.");
  return JSON.parse(text.slice(start, end + 1)) as Step;
}

/** Drops off-board probes and blocked commands. Falls back to the playbook step. */
export function polish(step: Step, input: DecideInput): Step {
  const cleaned = sanitize(step, input);
  if (!cleaned || blocked(cleaned, input) || !onBoard(cleaned, input)) {
    const safe = scriptedStep(input);
    return sanitize(safe, input) ?? {
      observation: {
        title: "No safe probe",
        body: "The turn had no on-board probe that the constraints allow.",
      },
      hypotheses: [],
      evidence_add: [],
      resolved: { class: "unknown", summary: "No safe on-board probe for this turn." },
    };
  }
  return cleaned;
}

function sanitize(step: Step, input: DecideInput): Step | null {
  if (!step || typeof step !== "object" || !step.observation) return null;
  const observation = {
    title: text(step.observation.title, "Diagnosis"),
    body: text(step.observation.body, ""),
    ...(step.observation.reasoning ? { reasoning: text(step.observation.reasoning, "") } : {}),
  };
  const hypotheses = (step.hypotheses ?? []).map(sanitizeHypothesis).filter((item): item is Hypothesis => item !== null);
  const evidence_add = (step.evidence_add ?? []).filter((item) => typeof item === "string");
  if (step.resolved) {
    const fault = step.resolved.class;
    if (!CLASSES.has(fault)) return null;
    return {
      observation,
      hypotheses,
      evidence_add,
      resolved: { class: fault, summary: text(step.resolved.summary, "") },
    };
  }
  const action = sanitizeAction(step.next_action, input);
  if (!action) return null;
  return { observation, hypotheses, evidence_add, next_action: action };
}

function sanitizeHypothesis(raw: Hypothesis): Hypothesis | null {
  if (!raw || typeof raw.id !== "string" || !STATUSES.has(raw.status)) return null;
  const confidence = Number(raw.confidence);
  return {
    id: raw.id,
    title: text(raw.title, raw.id),
    detail: text(raw.detail, ""),
    confidence: Math.min(1, Math.max(0, Number.isFinite(confidence) ? confidence : 0)),
    status: raw.status,
  };
}

function sanitizeAction(raw: NextAction | undefined, input: DecideInput): NextAction | null {
  if (!raw || !ACTIONS.has(raw.type)) return null;
  const probes = [];
  let reds = 0;
  let blacks = 0;
  for (const probe of raw.probes ?? []) {
    if (!probe || !LEADS.has(probe.lead) || !KINDS.has(probe.kind)) continue;
    if (probe.lead === "red" && reds >= 1) continue;
    if (probe.lead === "black" && blacks >= 1) continue;
    const pad = findPad(input.board, probe.target, probe.net) ?? findPad(input.board, probe.target);
    if (!pad || !nets(input.board).includes(probe.net)) continue;
    if (probe.lead === "red") reds += 1;
    else blacks += 1;
    probes.push({
      target: targetOf(pad),
      net: probe.net,
      lead: probe.lead,
      kind: probe.kind,
      label: text(probe.label, `${targetOf(pad)} · ${probe.net}`),
      ...(pad.x !== undefined ? { x: pad.x } : {}),
      ...(pad.y !== undefined ? { y: pad.y } : {}),
    });
  }
  if (raw.type === "probe" && probes.length === 0) return null;
  const action: NextAction = {
    title: text(raw.title, "Next check"),
    body: text(raw.body, ""),
    type: raw.type,
    probes,
  };
  if (raw.inputLabel) action.inputLabel = text(raw.inputLabel, "");
  if (raw.unit) action.unit = text(raw.unit, "");
  if (raw.command) action.command = text(raw.command, "");
  return action;
}

function blocked(step: Step, input: DecideInput): boolean {
  const action = step.next_action;
  if (!action) return false;
  const blob = `${action.command ?? ""}\n${action.title}\n${action.body}`;
  const allow = input.constraints ?? {};
  if (/mass erase|chip erase/i.test(blob) && !allow.allowMassErase) return true;
  if (/option bytes?/i.test(blob) && !allow.allowOptionBytes) return true;
  if (/\bfuses?\b/i.test(blob) && !allow.allowFuses) return true;
  if (/\botp\b/i.test(blob) && !allow.allowOtp) return true;
  const unit = (action.unit ?? "").toLowerCase();
  const continuity = unit === "ohm" || unit === "ohms" || unit === "ω" || /continu/.test(unit) || /continu/.test(action.title);
  if (continuity && allow.powered !== false) return true;
  return false;
}

function onBoard(step: Step, input: DecideInput): boolean {
  const probes = step.next_action?.probes ?? [];
  return probes.every((probe) => {
    const pad = findPad(input.board, probe.target, probe.net);
    return Boolean(pad && pad.net === probe.net);
  });
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
