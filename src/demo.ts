import path from "node:path";
import { pathToFileURL } from "node:url";

import { decide, remember, usedPlaybook } from "./decide.ts";
import { formatStep } from "./loop.ts";
import type { Board, DecideInput, ProbePoint, Reading, Step } from "./types.ts";

/** Divider from 3V3 to ground. Claude only sees these pads. */
export const presentationBoard: Board = {
  pads: [
    { ref: "TP2", pad: "1", net: "3V3", x: 14, y: 12 },
    { ref: "U1", pad: "3", net: "3V3", x: 8, y: 12 },
    { ref: "R1", pad: "1", net: "3V3", x: 28, y: 18 },
    { ref: "R1", pad: "2", net: "DIV", x: 36, y: 18 },
    { ref: "R2", pad: "1", net: "DIV", x: 36, y: 28 },
    { ref: "TP1", pad: "1", net: "DIV", x: 42, y: 18 },
    { ref: "R2", pad: "2", net: "GND", x: 36, y: 36 },
    { ref: "TP3", pad: "1", net: "GND", x: 14, y: 40 },
  ],
};

const SYMPTOM = "The divider should be 1.65 V and is not.";
const DIV_EXPECTED = 1.65;
const DIV_MIN = Math.round(DIV_EXPECTED * 0.9 * 1000) / 1000;
const DIV_MAX = Math.round(DIV_EXPECTED * 1.1 * 1000) / 1000;

/** Divider node is the 2 V reading. The 3V3 rail is the 3.3 V reading. */
const CANNED: Record<string, { value: number; unit: string; expected: number }> = {
  DIV: { value: 2, unit: "V", expected: DIV_EXPECTED },
  "3V3": { value: 3.3, unit: "V", expected: 3.3 },
};

export function presentationInput(): DecideInput {
  return {
    symptom: SYMPTOM,
    board: presentationBoard,
    constraints: { powered: true },
    failedTest: { net: "DIV", min: DIV_MIN, max: DIV_MAX, unit: "V" },
  };
}

/** Presentation board and symptom, with the caller's readings stamped onto DIV then 3V3. */
export function presentationState(raw: Partial<DecideInput> | null | undefined): DecideInput {
  const base = presentationInput();
  const state: DecideInput = { ...base, readings: stampPresentationReadings(raw) };
  if (Array.isArray(raw?.hypotheses)) state.hypotheses = raw.hypotheses;
  if (Array.isArray(raw?.evidence)) state.evidence = raw.evidence.filter((item) => typeof item === "string");
  return state;
}

/**
 * Fixed replay of the presentation story.
 * No readings: probe DIV. One reading: probe 3V3. Two readings: R1 or R2 is the fault.
 * The text is the story (2 V, then 3.3 V), so a bad model key cannot change it.
 */
export function cannedPresentationStep(raw: Partial<DecideInput> | null | undefined): Step {
  const readings = presentationState(raw).readings ?? [];
  const hasDiv = readings.some((reading) => reading.net === "DIV");
  const hasRail = readings.some((reading) => reading.net === "3V3");
  if (!hasDiv) return dividerProbeStep();
  if (!hasRail) return railProbeStep();
  return resistorFaultStep();
}

/** One presentation turn. A set OpenAI key calls decide(). DEMO_CANNED does not use this. */
export async function presentationDecide(raw: Partial<DecideInput> | null | undefined): Promise<Step> {
  const state = presentationState(raw);
  const previousMode = process.env.SB_AI;
  if (process.env.OPENAI_API_KEY?.trim()) process.env.SB_AI = "live";
  try {
    const step = await liveStep(state);
    if (!step) throw new Error("That pad is not on this board.");
    return step;
  } finally {
    if (previousMode === undefined) delete process.env.SB_AI;
    else process.env.SB_AI = previousMode;
  }
}

/** One live investigation. Readings are canned. No Fixtr session and no playbook turn. */
export async function runPresentation(
  write: (line: string) => void = console.log,
  writeErr: (line: string) => void = console.error,
): Promise<number> {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    writeErr("OPENAI_API_KEY is required.");
    return 1;
  }
  const previousMode = process.env.SB_AI;
  process.env.SB_AI = "live";
  try {
    write("These readings are stand-ins for the bench.");
    write("");
    write(`Problem: ${SYMPTOM}`);
    let state = presentationInput();
    for (let turn = 0; turn < 4; turn++) {
      const step = await liveStep(state);
      if (!step) {
        writeErr("That pad is not on this board.");
        return 1;
      }
      write(formatStep(step));
      if (step.resolved) return 0;
      const red = signalPad(step);
      if (!red || red.x === undefined || red.y === undefined) {
        writeErr("That pad is not on this board.");
        return 1;
      }
      write(`Moving to ${red.x}, ${red.y} mm.`);
      const canned = CANNED[red.net];
      if (!canned) {
        writeErr(`No canned reading for ${red.net}.`);
        return 1;
      }
      write(`Measured ${formatNum(canned.value)} ${canned.unit}, expected ${formatNum(canned.expected)} ${canned.unit}.`);
      const reading: Reading = {
        value: canned.value,
        unit: canned.unit,
        target: red.target,
        net: red.net,
      };
      state = remember(state, step, reading);
    }
    writeErr("The investigation did not resolve.");
    return 1;
  } finally {
    if (previousMode === undefined) delete process.env.SB_AI;
    else process.env.SB_AI = previousMode;
  }
}

/** decide() drops an off-board pad. One retry, then stop. The playbook step is not shown. */
async function liveStep(state: DecideInput): Promise<Step | undefined> {
  let step = await decide(state);
  if (rejected(step)) step = await decide(state);
  if (rejected(step)) return undefined;
  return step;
}

function rejected(step: Step): boolean {
  if (usedPlaybook(step)) return true;
  if (step.resolved) return false;
  return !signalPad(step);
}

function signalPad(step: Step): ProbePoint | undefined {
  if (step.next_action?.type !== "probe") return undefined;
  const red = step.next_action.probes.find((probe) => probe.lead === "red");
  if (!red || red.x === undefined || red.y === undefined) return undefined;
  const onBoard = presentationBoard.pads.some((pad) => `${pad.ref}.${pad.pad}` === red.target && pad.net === red.net);
  return onBoard ? red : undefined;
}

function stampPresentationReadings(raw: Partial<DecideInput> | null | undefined): Reading[] {
  const list = [...(raw?.readings ?? [])];
  if (raw?.reading) list.push(raw.reading);
  const stamped: Reading[] = [];
  const pending: Reading[] = [];
  for (const item of list) {
    if (!item) continue;
    const value = typeof item.value === "number" ? item.value : Number(item.value);
    if (!Number.isFinite(value)) continue;
    const reading: Reading = { value };
    if (typeof item.unit === "string" && item.unit.trim()) reading.unit = item.unit.trim();
    if (typeof item.target === "string" && item.target.trim()) reading.target = item.target.trim();
    const net = typeof item.net === "string" ? item.net.trim() : "";
    if (net === "DIV" || net === "3V3") {
      reading.net = net;
      if (!reading.target) reading.target = net === "DIV" ? "TP1.1" : "TP2.1";
      if (!reading.unit) reading.unit = "V";
      stamped.push(reading);
    } else pending.push(reading);
  }
  const used = new Set(stamped.map((reading) => reading.net));
  for (const reading of pending) {
    if (!used.has("DIV")) {
      reading.net = "DIV";
      reading.target ??= "TP1.1";
      reading.unit ??= "V";
      used.add("DIV");
      stamped.push(reading);
    } else if (!used.has("3V3")) {
      reading.net = "3V3";
      reading.target ??= "TP2.1";
      reading.unit ??= "V";
      used.add("3V3");
      stamped.push(reading);
    }
  }
  return stamped;
}

function dividerProbeStep(): Step {
  return {
    observation: {
      title: "Check the divider",
      body: "The divider should be 1.65 V. Measure DIV.",
      reasoning: "The divider node is measured before the source rail.",
    },
    hypotheses: [
      { id: "H1", title: "Divider resistor", detail: "R1 or R2 is out of value.", confidence: 0.5, status: "active" },
      { id: "H2", title: "3V3 rail", detail: "The source rail may be out of window.", confidence: 0.5, status: "active" },
    ],
    evidence_add: [],
    next_action: {
      title: "Measure DIV",
      body: "Red lead on TP1 pad 1 (DIV). Black lead on TP3 pad 1 (GND).",
      type: "probe",
      probes: [
        { target: "TP1.1", net: "DIV", lead: "red", kind: "probe", label: "TP1.1 · DIV", x: 42, y: 18 },
        { target: "TP3.1", net: "GND", lead: "black", kind: "probe", label: "TP3.1 · GND", x: 14, y: 40 },
      ],
      inputLabel: "Voltage on DIV",
      unit: "V",
    },
  };
}

function railProbeStep(): Step {
  return {
    observation: {
      title: "Check the source rail",
      body: "DIV measured 2 V, expected 1.65 V. Measure 3V3 before calling the resistors.",
      reasoning: "2 V on DIV is outside the window. The 3V3 rail separates a bad regulator from a resistor fault.",
    },
    hypotheses: [
      { id: "H1", title: "Divider resistor", detail: "DIV is 2 V, outside 1.65 V.", confidence: 0.7, status: "active" },
      { id: "H2", title: "3V3 rail", detail: "The source rail is still unchecked.", confidence: 0.3, status: "active" },
    ],
    evidence_add: ["DIV measured 2 V"],
    next_action: {
      title: "Measure 3V3",
      body: "Red lead on TP2 pad 1 (3V3). Black lead on TP3 pad 1 (GND).",
      type: "probe",
      probes: [
        { target: "TP2.1", net: "3V3", lead: "red", kind: "probe", label: "TP2.1 · 3V3", x: 14, y: 12 },
        { target: "TP3.1", net: "GND", lead: "black", kind: "probe", label: "TP3.1 · GND", x: 14, y: 40 },
      ],
      inputLabel: "Voltage on 3V3",
      unit: "V",
    },
  };
}

function resistorFaultStep(): Step {
  return {
    observation: {
      title: "Divider resistor",
      body: "DIV measured 2 V, expected 1.65 V. 3V3 measured 3.3 V and is in window. R1 or R2 is faulty. Replace R1 or R2.",
      reasoning: "The divider node is outside its window and the source rail is in window.",
    },
    hypotheses: [
      { id: "H1", title: "Divider resistor", detail: "R1 or R2 is faulty.", confidence: 0.9, status: "confirmed" },
      { id: "H2", title: "3V3 rail", detail: "3V3 measured 3.3 V.", confidence: 0.1, status: "ruled_out" },
    ],
    evidence_add: ["3V3 measured 3.3 V"],
    resolved: { class: "hardware", summary: "R1 or R2 is faulty. Replace R1 or R2." },
  };
}

function formatNum(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1000) / 1000);
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
  runPresentation()
    .then((code) => {
      if (code) process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    });
}
