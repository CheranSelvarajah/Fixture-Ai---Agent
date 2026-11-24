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

/** One live investigation. Readings are canned. No Fixtr session and no playbook turn. */
export async function runPresentation(
  write: (line: string) => void = console.log,
  writeErr: (line: string) => void = console.error,
): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    writeErr("ANTHROPIC_API_KEY is required.");
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
