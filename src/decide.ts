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
const PLAYBOOK_TURN = "this turn used the playbook";

/** True when polish replaced the model reply with the playbook. */
export function usedPlaybook(step: Step): boolean {
  return (step.observation?.reasoning ?? "").includes(PLAYBOOK_TURN)
    || step.resolved?.summary === "No safe on-board probe for this turn.";
}

/**
 * One investigation turn in, one step out.
 * OPENAI_API_KEY calls OpenAI. ANTHROPIC_API_KEY calls Claude when no OpenAI key is set.
 * SB_AI=live or SB_AI=agent also calls the model. SB_AI=mock, or no key, follows the playbook.
 * Either way the reply is checked against the board.
 */
export async function decide(raw: DecideInput): Promise<Step> {
  const input = normalizeInput(raw);
  if (!usesModel()) return polish(scriptedStep(input), input);
  const drafted = await modelStep(input);
  return polish(drafted, input);
}

/** The model investigates when a key is set, unless mock mode is forced. */
export function usesModel(): boolean {
  const mode = (process.env.SB_AI ?? "").trim().toLowerCase();
  if (mode === "mock") return false;
  if (mode === "live" || mode === "agent") return true;
  return Boolean(openaiKey() || anthropicKey());
}

/** Carry this turn's hypotheses, evidence, and reading into the next decide() call. */
export function remember(input: DecideInput, step: Step, reading?: Reading): DecideInput {
  const readings = [...(input.readings ?? [])];
  if (reading) readings.push(reading);
  return {
    ...input,
    readings,
    hypotheses: step.hypotheses,
    evidence: [...(input.evidence ?? []), ...step.evidence_add],
    reading: undefined,
  };
}

/** Prompt for one investigation turn. The model sees its own hypotheses from the last turn. */
export function agentPrompt(playbook: string, input: DecideInput): { system: string; user: string } {
  const pads = input.board.pads.map((pad) => ({
    target: targetOf(pad),
    ref: pad.ref,
    pad: pad.pad,
    net: pad.net,
    ...(pad.x !== undefined ? { x: pad.x } : {}),
    ...(pad.y !== undefined ? { y: pad.y } : {}),
  }));
  const system = [
    "You are the debug agent for one reported PCB fault. You investigate. You do not write a bring-up plan or firmware.",
    "Each turn, update the hypotheses you already have, then either request one measurement or resolve the fault.",
    "The next probe is the one measurement that separates your two leading active hypotheses.",
    "When the symptom still spans several domains, check power, then clock and reset, then one bus, and only then firmware.",
    "Use only a target and a net from the allowed pads. A measurement is one red lead on the signal and one black lead on ground.",
    "On resolve, the summary names the cause and one recommended fix: which part on the failing net to check, or a firmware change when the rails, clock, reset, and bus are in window.",
    "Return one JSON object and nothing else. Include next_action or resolved, not both.",
    playbook,
  ].join("\n\n");
  const user = JSON.stringify({
    symptom: input.symptom,
    constraints: input.constraints ?? { powered: true },
    failedTest: input.failedTest ?? null,
    hypotheses: input.hypotheses ?? [],
    evidence: input.evidence ?? [],
    readings: input.readings ?? [],
    allowedPads: pads,
  });
  return { system, user };
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

function openaiKey(): string | undefined {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key || undefined;
}

function anthropicKey(): string | undefined {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  return key || undefined;
}

async function modelStep(input: DecideInput): Promise<Step> {
  const playbook = readFileSync(fileURLToPath(PLAYBOOK_URL), "utf8");
  const { system, user } = agentPrompt(playbook, input);
  const openai = openaiKey();
  if (openai) return openAiStep(openai, system, user);
  const anthropic = anthropicKey();
  if (anthropic) return anthropicStep(anthropic, system, user);
  throw new Error("The debug agent needs OPENAI_API_KEY or ANTHROPIC_API_KEY. SB_AI=mock runs the playbook with no key.");
}

async function openAiStep(key: string, system: string, user: string): Promise<Step> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 2000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Model request failed (${response.status}).`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
  return parseStep(payload.choices?.[0]?.message?.content ?? "");
}

async function anthropicStep(key: string, system: string, user: string): Promise<Step> {
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
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: user }],
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
    const safe = sanitize(scriptedStep(input), input);
    if (!safe) return {
      observation: {
        title: "No safe probe",
        body: "The turn had no on-board probe that the constraints allow.",
      },
      hypotheses: [],
      evidence_add: [],
      resolved: { class: "unknown", summary: "No safe on-board probe for this turn." },
    };
    return {
      ...safe,
      observation: {
        ...safe.observation,
        reasoning: `The model reply was not a safe on-board probe, so ${PLAYBOOK_TURN}. ${safe.observation.reasoning ?? ""}`.trim(),
      },
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
