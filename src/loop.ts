import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { cases, runMockCases } from "./cases.ts";
import { decide, remember, usesModel } from "./decide.ts";
import { loadDecideInput } from "./fixtr.ts";
import type { DecideInput, Reading, Step } from "./types.ts";

const args = process.argv.slice(2);

if (import.meta.url === mainUrl()) {
  main(args).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}

function mainUrl(): string {
  const entry = process.argv[1];
  if (!entry) return "";
  return pathToFileURL(path.resolve(entry)).href;
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--mock")) {
    const runs = await runMockCases();
    for (const run of runs) {
      const item = cases.find((entry) => entry.id === run.id);
      console.log(`${run.id}: ${item?.symptom}`);
      console.log(`  probes: ${run.nets.join(" -> ")}`);
      console.log(`  ${run.fault}: ${run.summary}`);
    }
    console.log("mock loop passed");
    return;
  }

  const sessionFlag = flag(argv, "--session");
  const fixtureFlag = flag(argv, "--fixture");
  let input: DecideInput;
  if (sessionFlag) input = await loadDecideInput(sessionFlag);
  else if (fixtureFlag) input = JSON.parse(readFileSync(fixtureFlag, "utf8")) as DecideInput;
  else {
    console.error("Usage: node src/loop.ts --mock | --session <id> | --fixture <file.json>");
    process.exitCode = 1;
    return;
  }

  if (!input.symptom?.trim()) {
    console.error("The session has no symptom. This agent does not write a bring-up plan.");
    process.exitCode = 1;
    return;
  }

  let state = input;
  console.log(usesModel() ? "Debug agent (model)." : "No API key set, so this loop is using the playbook.");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const step = await decide(state);
      printStep(step);
      if (step.resolved || !step.next_action) return;
      const line = (await rl.question(`${step.next_action.inputLabel ?? "Reading"}${step.next_action.unit ? ` (${step.next_action.unit})` : ""}: `)).trim();
      if (line === "q" || line === "") return;
      const parsed = parseReading(line, step.next_action.unit);
      if (!parsed) {
        console.log("Enter a number, optionally with a unit.");
        continue;
      }
      const red = step.next_action.probes.find((probe) => probe.lead === "red");
      const reading: Reading = {
        value: parsed.value,
        ...(parsed.unit ? { unit: parsed.unit } : {}),
        ...(red ? { target: red.target, net: red.net } : {}),
      };
      state = remember(state, step, reading);
    }
  } finally {
    rl.close();
  }
}

export function formatStep(step: Step): string {
  const lines = [`\n${step.observation.title}`, step.observation.body];
  if (step.observation.reasoning) lines.push(step.observation.reasoning);
  for (const item of step.hypotheses) {
    lines.push(`  [${item.status}] ${item.title} (${item.confidence})`);
  }
  if (step.resolved) {
    lines.push(`\nresolved ${step.resolved.class}: ${step.resolved.summary}`);
    return lines.join("\n");
  }
  const action = step.next_action;
  if (!action) return lines.join("\n");
  lines.push(`\n${action.title}`);
  for (const probe of action.probes) {
    const at = probe.x !== undefined && probe.y !== undefined ? ` @ ${probe.x}, ${probe.y} mm` : "";
    lines.push(`  ${probe.lead} ${probe.label}${at}`);
  }
  return lines.join("\n");
}

function printStep(step: Step): void {
  console.log(formatStep(step));
}

function parseReading(line: string, fallbackUnit: string | undefined): { value: number; unit?: string } | null {
  const match = line.match(/^(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*([a-zA-ZΩ]+)?$/i);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: match[2] ?? fallbackUnit };
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}
