import path from "node:path";
import { pathToFileURL } from "node:url";

import { decide, remember } from "./decide.ts";
import { formatStep } from "./loop.ts";
import type { Board, DecideInput, Reading } from "./types.ts";

/** Divider from 3V3 to ground. The symptom, not the presenter, picks the pad. */
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

/** One scripted investigation. Readings are canned. No Fixtr session and no model call. */
export async function runPresentation(write: (line: string) => void = console.log): Promise<void> {
  const previousMode = process.env.SB_AI;
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.SB_AI = "mock";
  delete process.env.ANTHROPIC_API_KEY;
  try {
    write("These readings are stand-ins for the bench.");
    write("");
    write(`Problem: ${SYMPTOM}`);
    let state = presentationInput();
    for (let turn = 0; turn < 4; turn++) {
      const step = await decide(state);
      write(formatStep(step));
      if (step.resolved || !step.next_action) return;
      const red = step.next_action.probes.find((probe) => probe.lead === "red");
      if (!red || step.next_action.type !== "probe" || red.x === undefined || red.y === undefined) {
        throw new Error("Presentation expected one probe with a pad position.");
      }
      write(`Moving to ${red.x}, ${red.y} mm.`);
      const canned = CANNED[red.net];
      if (!canned) throw new Error(`No canned reading for ${red.net}.`);
      write(`Measured ${formatNum(canned.value)} ${canned.unit}, expected ${formatNum(canned.expected)} ${canned.unit}.`);
      const reading: Reading = {
        value: canned.value,
        unit: canned.unit,
        target: red.target,
        net: red.net,
      };
      state = remember(state, step, reading);
    }
    throw new Error("Presentation did not resolve.");
  } finally {
    if (previousMode === undefined) delete process.env.SB_AI;
    else process.env.SB_AI = previousMode;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
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
  runPresentation().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
