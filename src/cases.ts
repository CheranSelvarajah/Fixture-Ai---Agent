import { decide } from "./decide.ts";
import type { Board, FaultClass, Reading } from "./types.ts";

/** One parsed board. The symptom, not the engineer, picks the pad. */
export const demoBoard: Board = {
  pads: [
    { ref: "TP1", pad: "1", net: "3V3", x: 10, y: 20 },
    { ref: "C1", pad: "1", net: "3V3", x: 11, y: 20 },
    { ref: "U1", pad: "16", net: "3V3", x: 30, y: 40 },
    { ref: "TP2", pad: "1", net: "GND", x: 10, y: 5 },
    { ref: "U1", pad: "8", net: "GND", x: 30, y: 36 },
    { ref: "TP5", pad: "1", net: "HSE", x: 18, y: 22 },
    { ref: "Y1", pad: "1", net: "HSE", x: 16, y: 22 },
    { ref: "U1", pad: "5", net: "HSE", x: 28, y: 40 },
    { ref: "TP3", pad: "1", net: "NRST", x: 22, y: 8 },
    { ref: "U1", pad: "7", net: "NRST", x: 32, y: 40 },
    { ref: "TP4", pad: "1", net: "SWDIO", x: 25, y: 8 },
    { ref: "U1", pad: "23", net: "SWDIO", x: 34, y: 40 },
  ],
};

export type ScriptedCase = {
  id: string;
  symptom: string;
  readings: Reading[];
  expectNets: string[];
  expectTarget: string;
  expectClass: FaultClass;
};

export const cases: ScriptedCase[] = [
  {
    id: "dead-rail",
    symptom: "The 3V3 rail is dead",
    readings: [{ value: 0.04, unit: "V" }],
    expectNets: ["3V3"],
    expectTarget: "TP1.1",
    expectClass: "hardware",
  },
  {
    id: "missing-clock",
    symptom: "HSE clock is missing",
    readings: [
      { value: 3.3, unit: "V" },
      { value: 0, unit: "Hz" },
    ],
    expectNets: ["3V3", "HSE"],
    expectTarget: "TP1.1",
    expectClass: "hardware",
  },
  {
    id: "firmware-not-running",
    symptom: "Firmware is not running",
    readings: [
      { value: 3.3, unit: "V" },
      { value: 8_000_000, unit: "Hz" },
      { value: 3.3, unit: "V" },
      { value: 3.3, unit: "V" },
    ],
    expectNets: ["3V3", "HSE", "NRST", "SWDIO"],
    expectTarget: "TP1.1",
    expectClass: "firmware",
  },
];

export type CaseRun = {
  id: string;
  nets: string[];
  target: string;
  fault: FaultClass;
  summary: string;
};

export async function runCase(item: ScriptedCase, board: Board = demoBoard): Promise<CaseRun> {
  const readings: Reading[] = [];
  const nets: string[] = [];
  let target = "";
  for (let turn = 0; turn < 8; turn++) {
    const step = await decide({
      symptom: item.symptom,
      board,
      readings,
      constraints: { powered: true },
    });
    if (step.resolved) {
      return { id: item.id, nets, target, fault: step.resolved.class, summary: step.resolved.summary };
    }
    const red = step.next_action?.probes.find((probe) => probe.lead === "red");
    if (!red || !step.next_action || step.next_action.probes.filter((probe) => probe.lead === "red").length !== 1) {
      throw new Error(`${item.id} did not return one probe`);
    }
    if (nets.length === 0) target = red.target;
    nets.push(red.net);
    const sample = item.readings[nets.length - 1];
    if (!sample) throw new Error(`${item.id} asked for ${red.net} after the scripted readings ended`);
    readings.push({ ...sample, target: red.target, net: red.net });
  }
  throw new Error(`${item.id} did not resolve`);
}

export async function runMockCases(): Promise<CaseRun[]> {
  const previous = process.env.SB_AI;
  process.env.SB_AI = "mock";
  try {
    const runs: CaseRun[] = [];
    for (const item of cases) {
      const run = await runCase(item);
      const netsMatch = run.nets.join(",") === item.expectNets.join(",");
      const ok = netsMatch && run.target === item.expectTarget && run.fault === item.expectClass;
      if (!ok) {
        throw new Error(
          `${item.id} expected ${item.expectTarget} then ${item.expectNets.join(" -> ")} => ${item.expectClass}, got ${run.target} then ${run.nets.join(" -> ")} => ${run.fault}`,
        );
      }
      runs.push(run);
    }
    return runs;
  } finally {
    if (previous === undefined) delete process.env.SB_AI;
    else process.env.SB_AI = previous;
  }
}
