import { kindFor, netClass, nets, padsOn, pickPad, railNominal, targetOf, type NetClass } from "./board.ts";
import type {
  Board,
  DecideInput,
  Hypothesis,
  NextAction,
  Pad,
  ProbePoint,
  Reading,
  Resolved,
  Step,
} from "./types.ts";

type StageName = "divider" | "power" | "clock" | "reset" | "bus";

type Plan = {
  stages: StageName[];
  netFor: Partial<Record<StageName, string>>;
  /** Symptom names a net the board does not have. */
  missingNamed?: string;
  /** The report is a divider and the board has no resistor node. */
  dividerMissing?: boolean;
  /** After the electrical stages pass, the report is that code is not running. */
  firmware: boolean;
};

export function scriptedStep(input: DecideInput): Step {
  const board = input.board;
  const symptom = input.symptom.trim();
  if (!symptom) {
    return questionStep("The report needs a symptom", "Say what is failing on this board. This agent does not write a bring-up plan.");
  }
  if (board.pads.length === 0) {
    return resolvedStep(
      [],
      [],
      {
        title: "No parsed pads",
        body: "The board payload has no pads, so there is nowhere to land a probe.",
        reasoning: "Probe targets come only from the parsed board.",
      },
      { class: "plan", summary: "The parsed board has no pads to probe." },
    );
  }

  const plan = buildPlan(symptom, board);
  if (plan.dividerMissing) {
    return resolvedStep(
      hypotheses(plan, null, "plan"),
      [],
      {
        title: "No divider node on this board",
        body: "The report is a divider, and the parsed board has no resistor node to measure.",
        reasoning: "A divider fault is separated on the resistor node and the source rail.",
      },
      { class: "plan", summary: "The parsed board has no divider node to probe." },
    );
  }

  if (plan.missingNamed) {
    return resolvedStep(
      hypotheses(plan, null, "plan"),
      [`Reported net ${plan.missingNamed} is not on the parsed board.`],
      {
        title: "That net is not on this board",
        body: `${plan.missingNamed} is in the report and is not a net on the parsed board.`,
        reasoning: "A probe has to land on a ref and a net Noah's parser actually produced.",
      },
      {
        class: "plan",
        summary: `${plan.missingNamed} is not a net on the parsed board, so the report does not match this board.`,
      },
    );
  }

  if (plan.stages.length === 0) {
    return resolvedStep(
      hypotheses(plan, null, "plan"),
      [],
      {
        title: "No net to probe",
        body: "The report needs a power, clock, reset, or bus net, and the parsed board has none.",
        reasoning: "Probe targets stay on nets Noah's parser produced.",
      },
      { class: "plan", summary: "The parsed board has no net the report can be checked on." },
    );
  }

  const readings = input.readings ?? [];
  const latest = readings.length > 0 ? readings[readings.length - 1] : undefined;
  const evidence = latest ? [readingLine(latest)] : [];
  const bound = bindReadings(readings, plan, board);

  for (const stage of plan.stages) {
    const net = plan.netFor[stage];
    if (!net) continue;
    const reading = bound.get(stage);
    if (!reading) {
      return probeStep(input, plan, stage, net, evidence, latest);
    }
    if (input.constraints?.powered === false && stage === "power") {
      if (reading.value <= 20) return hardware(plan, stage, net, reading, evidence, "short");
      return powerUpQuestion(net, evidence);
    }
    const verdict = judge(board, net, reading, input);
    if (verdict === "unit") {
      return resolvedStep(
        hypotheses(plan, stage, "setup"),
        evidence,
        {
          title: "Reading unit does not match the net",
          body: `${readingLine(reading)} is not in the unit this net is checked in.`,
          reasoning: "A pass window only applies when the unit matches the failed test or the net.",
        },
        {
          class: "setup",
          summary: `${readingLine(reading)} uses a unit that does not match ${net}.`,
        },
      );
    }
    if (stage === "divider" && verdict === "good") {
      return resolvedStep(
        hypotheses(plan, null, "setup"),
        evidence,
        {
          title: "The reported fault is not on this measurement",
          body: `${readingLine(reading)} is inside the window for ${net}.`,
          reasoning: "The symptom named this domain, and the reading does not show that fault.",
        },
        {
          class: "setup",
          summary: `${net} reads ${formatNum(reading.value)} ${reading.unit ?? ""}. That does not match the report.`.trim(),
        },
      );
    }
    if (stage === "divider" && verdict === "bad" && plan.netFor.power) continue;
    if (verdict === "bad") {
      if (stage === "divider") return resistorFault(board, plan, net, reading, evidence);
      return hardware(plan, stage, net, reading, evidence, "window");
    }
  }

  const dividerNetName = plan.netFor.divider;
  const dividerReading = bound.get("divider");
  const railNet = plan.netFor.power;
  const railReading = railNet ? bound.get("power") : undefined;
  if (dividerNetName && dividerReading && railNet && railReading && judge(board, dividerNetName, dividerReading, input) === "bad" && judge(board, railNet, railReading, input) === "good") {
    return resistorFault(board, plan, dividerNetName, dividerReading, evidence, railNet);
  }

  if (plan.firmware) {
    return resolvedStep(
      hypotheses(plan, null, "firmware"),
      evidence,
      {
        title: "Rails, clock, reset, and the bus read like a live board",
        body: "The electrical checks in front of firmware are inside their windows. The report is that the code is not running.",
        reasoning: "Power, then clock and reset, then a bus, all passed. The remaining class is firmware.",
      },
      {
        class: "firmware",
        summary: "Power, clock, reset, and the bus are in window. The fault class is firmware.",
      },
    );
  }

  const lastStage = plan.stages[plan.stages.length - 1];
  const lastNet = lastStage ? plan.netFor[lastStage] : undefined;
  const lastReading = lastStage ? bound.get(lastStage) : undefined;
  return resolvedStep(
    hypotheses(plan, null, "setup"),
    evidence,
    {
      title: "The reported fault is not on this measurement",
      body: lastReading && lastNet
        ? `${readingLine(lastReading)} is inside the window for ${lastNet}.`
        : "The checks the symptom asked for are inside their windows.",
      reasoning: "The symptom named this domain, and the reading does not show that fault.",
    },
    {
      class: "setup",
      summary: lastNet && lastReading
        ? `${lastNet} reads ${formatNum(lastReading.value)} ${lastReading.unit ?? ""}. That does not match the report.`.trim()
        : "The measurements do not match the reported fault.",
    },
  );
}

function buildPlan(symptom: string, board: Board): Plan {
  const text = symptom.toLowerCase();
  const wantsFirmware = /firmware|not running|does not run|doesn't run|do not run|don't run|not executing|software|no blink/.test(text);
  const wantsClock = /clock|oscill|crystal|\bhse\b|\blse\b|xtal/.test(text);
  const wantsReset = /reset|\bnrst\b/.test(text);
  const wantsBus = /i2c|spi|uart|swd|can|\bbus\b|\bsda\b|\bscl\b|nack|no ack/.test(text);
  const wantsPower = /rail|power|brownout|no voltage|dead|\bvdd\b|\bvcc\b|\d+\s*v\d*|\d+\.\d+/.test(text);
  const wantsDivider = /divider/.test(text);

  const namedPower = namedNet(symptom, board, "power");
  const namedClock = namedNet(symptom, board, "clock");
  const namedReset = namedNet(symptom, board, "reset");
  const namedBus = namedNet(symptom, board, "bus");

  const missingNamed = missingName(symptom, board);
  if (missingNamed) {
    return { stages: [], netFor: {}, missingNamed, firmware: false };
  }

  if (wantsDivider) {
    const mid = dividerNet(board);
    if (!mid) return { stages: [], netFor: {}, firmware: false, dividerMissing: true };
    const source = namedPower ?? logicRail(board);
    const netFor: Plan["netFor"] = { divider: mid };
    const stages: StageName[] = ["divider"];
    if (source && source !== mid) {
      stages.push("power");
      netFor.power = source;
    }
    return { stages, netFor, firmware: false };
  }

  let stages: StageName[];
  if (wantsFirmware) stages = ["power", "clock", "reset", "bus"];
  else if (wantsBus) stages = ["power", "clock", "reset", "bus"];
  else if (wantsClock) stages = ["power", "clock"];
  else if (wantsReset) stages = ["power", "clock", "reset"];
  else if (wantsPower || (!wantsClock && !wantsReset && !wantsBus)) stages = ["power"];
  else stages = ["power", "clock", "reset", "bus"];

  const netFor: Plan["netFor"] = {};
  for (const stage of stages) {
    const net = stage === "power"
      ? namedPower ?? logicRail(board)
      : stage === "clock"
        ? namedClock ?? preferred(board, "clock", ["HSE", "OSC", "XTAL", "CLK"])
        : stage === "reset"
          ? namedReset ?? preferred(board, "reset", ["NRST", "NRESET", "RESET"])
          : namedBus ?? preferred(board, "bus", ["SWDIO", "SWCLK", "SDA", "SCL"]);
    if (net) netFor[stage] = net;
  }

  const present = stages.filter((stage) => netFor[stage]);
  return { stages: present, netFor, firmware: wantsFirmware };
}

function missingName(symptom: string, board: Board): string | undefined {
  const upper = symptom.toUpperCase();
  const tokens = upper.match(/\b\d+\s*V\d+\b|\b\d+(?:\.\d+)?\s*V\b|\b(?:HSE|LSE|NRST|NRESET|SWDIO|SWCLK)\b/g) ?? [];
  for (const token of tokens) {
    const compact = token.replace(/\s+/g, "");
    // A decimal such as 1.65 V is a schematic value, not a net name.
    if (/^\d+\.\d+V$/.test(compact)) continue;
    const nom = voltageToken(compact);
    const have = nets(board).some((net) => {
      const n = net.toUpperCase().replace(/\s+/g, "");
      if (n === compact || n.includes(compact) || compact.includes(n)) return true;
      return nom !== null && railNominal(net) === nom;
    });
    if (!have) return compact;
  }
  return undefined;
}

function voltageToken(token: string): number | null {
  const split = token.match(/^(\d+)V(\d+)$/);
  if (split?.[1] && split[2]) return Number(split[1]) + Number(split[2]) / 10 ** split[2].length;
  const whole = token.match(/^(\d+(?:\.\d+)?)V$/);
  if (whole?.[1]) return Number(whole[1]);
  return null;
}

function namedNet(symptom: string, board: Board, cls: NetClass): string | undefined {
  const upper = symptom.toUpperCase().replace(/\s+/g, "");
  const matches = nets(board).filter((net) => netClass(net) === cls && upper.includes(net.toUpperCase().replace(/\s+/g, "")));
  return matches.sort((a, b) => b.length - a.length)[0];
}

function preferred(board: Board, cls: NetClass, order: string[]): string | undefined {
  const found = nets(board).filter((net) => netClass(net) === cls);
  for (const hint of order) {
    const hit = found.find((net) => net.toUpperCase().includes(hint));
    if (hit) return hit;
  }
  return found[0];
}

function dividerNet(board: Board): string | undefined {
  const candidates = nets(board).filter((net) => {
    const cls = netClass(net);
    if (cls !== "other") return false;
    return padsOn(board, net).some((pad) => /^R\d/i.test(pad.ref));
  });
  return candidates.find((net) => /DIV|MID|SENSE|VREF/i.test(net)) ?? candidates[0];
}

function logicRail(board: Board): string | undefined {
  const power = nets(board).filter((net) => netClass(net) === "power");
  for (const name of ["3V3", "+3V3", "VCC", "VDD"]) {
    const hit = power.find((net) => net.toUpperCase() === name);
    if (hit) return hit;
  }
  const regulated = power
    .map((net) => ({ net, nom: railNominal(net) }))
    .filter((item): item is { net: string; nom: number } => item.nom !== null && item.nom > 0 && item.nom <= 3.6)
    .sort((a, b) => b.nom - a.nom);
  if (regulated[0]) return regulated[0].net;
  return power.find((net) => !/VIN|VBUS|VBAT/.test(net.toUpperCase())) ?? power[0];
}

function groundNet(board: Board): string | undefined {
  return preferred(board, "ground", ["GND"]);
}

function bindReadings(readings: Reading[], plan: Plan, board: Board): Map<StageName, Reading> {
  const bound = new Map<StageName, Reading>();
  const loose: Reading[] = [];
  for (const reading of readings) {
    const net = reading.net ?? netOfTarget(board, reading.target);
    const stage = net ? plan.stages.find((item) => plan.netFor[item] === net) : undefined;
    if (stage && !bound.has(stage)) bound.set(stage, reading);
    else if (!net) loose.push(reading);
  }
  for (const stage of plan.stages) {
    if (bound.has(stage)) continue;
    const next = loose.shift();
    const net = plan.netFor[stage];
    if (!next || !net) break;
    bound.set(stage, { ...next, net });
  }
  return bound;
}

function netOfTarget(board: Board, target: string | undefined): string | undefined {
  if (!target) return undefined;
  const pad = board.pads.find((item) => targetOf(item) === target || item.ref === target);
  return pad?.net;
}

type Verdict = "good" | "bad" | "unit";

function judge(board: Board, net: string, reading: Reading, input: DecideInput): Verdict {
  const failed = input.failedTest;
  const unit = reading.unit ?? defaultUnit(net, input);
  if (failed?.net === net && failed.min !== undefined && failed.max !== undefined) {
    if (failed.unit && reading.unit && !sameUnit(failed.unit, reading.unit)) return "unit";
    return reading.value >= failed.min && reading.value <= failed.max ? "good" : "bad";
  }
  const cls = netClass(net);
  if (cls === "power" || cls === "ground") {
    if (input.constraints?.powered === false) {
      return reading.value <= 20 ? "bad" : "good";
    }
    const nom = railNominal(net);
    if (nom === null) return "good";
    if (nom === 0) return Math.abs(reading.value) <= 0.1 ? "good" : "bad";
    const { min, max } = windowFor(nom);
    return reading.value >= min && reading.value <= max ? "good" : "bad";
  }
  if (cls === "clock") {
    const hz = toHertz(reading.value, unit);
    if (hz === null) return Math.abs(reading.value) < 0.05 ? "bad" : "good";
    return hz >= 1000 ? "good" : "bad";
  }
  const high = highLevel(board);
  if (cls === "reset" || cls === "bus") return reading.value >= high ? "good" : "bad";
  return "good";
}

function defaultUnit(net: string, input: DecideInput): string {
  if (input.constraints?.powered === false && netClass(net) === "power") return "ohm";
  if (netClass(net) === "clock") return "Hz";
  return "V";
}

function sameUnit(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function toHertz(value: number, unit: string): number | null {
  const u = unit.trim().toLowerCase();
  if (u === "hz") return value;
  if (u === "khz") return value * 1e3;
  if (u === "mhz") return value * 1e6;
  return null;
}

function windowFor(nom: number): { min: number; max: number } {
  return {
    min: Math.round(nom * 0.9 * 1000) / 1000,
    max: Math.round(nom * 1.1 * 1000) / 1000,
  };
}

function highLevel(board: Board): number {
  const rail = logicRail(board);
  const nom = rail ? railNominal(rail) : null;
  if (nom && nom > 0) return Math.round(nom * 0.6 * 1000) / 1000;
  return 2;
}

function probeStep(input: DecideInput, plan: Plan, stage: StageName, net: string, evidence: string[], latest: Reading | undefined): Step {
  const unpowered = input.constraints?.powered === false && stage === "power";
  const action = measurement(input.board, stage, net, unpowered, input);
  const dividerFollowUp = stage === "power" && Boolean(plan.netFor.divider) && latest?.net === plan.netFor.divider;
  const prior = !latest
    ? ""
    : dividerFollowUp
      ? `${readingLine(latest)} is outside the schematic window. `
      : `${readingLine(latest)} is in window. `;
  const why = unpowered
    ? "The board is unpowered, so this check is continuity."
    : stage === "divider"
      ? "The reported divider node is measured before the source rail."
      : dividerFollowUp
        ? "The divider node is outside its window. The source rail separates a faulty resistor from a bad regulator."
        : stage === "power"
          ? "Power is measured before a clock, a reset, or a bus."
          : stage === "clock"
            ? "The rail is in window. The clock is next, before reset or a bus."
            : stage === "reset"
              ? "Power and the clock are in window. Reset is next, before a bus."
              : "Power, clock, and reset are in window. One bus is next, before firmware.";
  return {
    observation: {
      title: action.title,
      body: `${prior}${action.body}`.trim(),
      reasoning: why,
    },
    hypotheses: hypotheses(plan, stage, null, dividerFollowUp ? "divider" : null),
    evidence_add: evidence,
    next_action: action,
  };
}

function measurement(board: Board, stage: StageName, net: string, unpowered: boolean, input: DecideInput): NextAction {
  const signal = pickPad(board, net, stage === "power" || stage === "divider" ? "power" : stage);
  const groundName = groundNet(board);
  const ground = groundName ? pickPad(board, groundName, "ground") : undefined;
  if (!signal || !ground) {
    return {
      title: "Parsed board is missing a pad for this check",
      body: signal ? "There is no ground pad to put the black lead on." : `There is no pad on ${net}.`,
      type: "question",
      probes: [],
      inputLabel: "Board correction",
    };
  }
  const red = point(signal, "red");
  const black = point(ground, "black");
  if (unpowered) {
    return {
      title: `Continuity on ${net}`,
      body: `Board is unpowered. Continuity from ${red.label} to ${black.label}. A short is under 20 ohm.`,
      type: "probe",
      probes: [red, black],
      inputLabel: `Ohms from ${net} to ${ground.net}`,
      unit: "ohm",
    };
  }
  if (stage === "divider") {
    const failed = input.failedTest;
    const span = failed?.net === net && failed.min !== undefined && failed.max !== undefined
      ? ` Schematic window is ${failed.min} V to ${failed.max} V.`
      : "";
    return {
      title: `Measure ${net}`,
      body: `Red on ${red.label}, black on ${black.label}.${span}`,
      type: "probe",
      probes: [red, black],
      inputLabel: `Voltage on ${net}`,
      unit: "V",
    };
  }
  if (stage === "clock") {
    return {
      title: `Measure ${net}`,
      body: `Red on ${red.label}, black on ${black.label}. A present clock is above 1 kHz.`,
      type: "probe",
      probes: [red, black],
      inputLabel: `Frequency on ${net}`,
      unit: "Hz",
    };
  }
  const nom = railNominal(net);
  const window = stage === "power" && nom ? windowFor(nom) : null;
  const span = window ? ` In window is ${window.min} V to ${window.max} V.` : "";
  return {
    title: `Measure ${net}`,
    body: `Red on ${red.label}, black on ${black.label}.${span}`,
    type: "probe",
    probes: [red, black],
    inputLabel: `Voltage on ${net}`,
    unit: "V",
  };
}

function point(pad: Pad, lead: "red" | "black"): ProbePoint {
  const probe: ProbePoint = {
    target: targetOf(pad),
    net: pad.net,
    lead,
    kind: kindFor(pad.ref),
    label: `${targetOf(pad)} · ${pad.net}`,
  };
  if (pad.x !== undefined) probe.x = pad.x;
  if (pad.y !== undefined) probe.y = pad.y;
  return probe;
}

function resistorRefs(board: Board, net: string): string[] {
  const refs = new Set<string>();
  for (const pad of padsOn(board, net)) {
    if (/^R\d/i.test(pad.ref)) refs.add(pad.ref);
  }
  return [...refs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function resistorFault(
  board: Board,
  plan: Plan,
  net: string,
  reading: Reading,
  evidence: string[],
  railNet?: string,
): Step {
  const names = resistorRefs(board, net);
  const part = names.length > 0 ? names.join(" or ") : `the resistor on ${net}`;
  const summary = railNet
    ? `${readingLine(reading)} is outside the schematic window for ${net}. ${railNet} is in window, so ${part} is faulty. Replace ${part}.`
    : `${readingLine(reading)} is outside the schematic window for ${net}, so ${part} is faulty. Replace ${part}.`;
  return resolvedStep(
    hypotheses(plan, "divider", "hardware"),
    evidence,
    {
      title: `${part} is faulty`,
      body: summary,
      reasoning: railNet
        ? "The divider node is outside its schematic window and the source rail is in window. The fault is a divider resistor."
        : "The divider node is outside its schematic window. The fault is a divider resistor.",
    },
    { class: "hardware", summary },
  );
}

function hardware(
  plan: Plan,
  stage: StageName,
  net: string,
  reading: Reading,
  evidence: string[],
  mode: "window" | "short",
): Step {
  const cls = netClass(net);
  const summary = mode === "short"
    ? `${net} is ${formatNum(reading.value)} ohm to ground with the board unpowered. That is a short.`
    : cls === "clock"
      ? `${readingLine(reading)}. The clock is missing.`
      : cls === "reset"
        ? `${readingLine(reading)}. Reset is stuck.`
        : cls === "bus"
          ? `${readingLine(reading)}. The bus is stuck.`
          : `${readingLine(reading)} is outside the window for ${net}.`;
  const title = mode === "short"
    ? `${net} is shorted`
    : cls === "clock"
      ? `${net} is missing`
      : cls === "reset" || cls === "bus"
        ? `${net} is stuck`
        : `${net} is out of window`;
  return resolvedStep(
    hypotheses(plan, stage, "hardware"),
    evidence,
    {
      title,
      body: summary,
      reasoning: "The first domain outside its window is the fault. Later domains stay unmeasured.",
    },
    { class: "hardware", summary },
  );
}

function powerUpQuestion(net: string, evidence: string[]): Step {
  return {
    observation: {
      title: `${net} is not shorted`,
      body: `Continuity on ${net} is not a short. Power the board before a voltage check. Continuity stays off once the board is powered.`,
      reasoning: "An unpowered ohms check can show a short. It cannot show a live rail.",
    },
    hypotheses: [],
    evidence_add: evidence,
    next_action: {
      title: "Power the board",
      body: `Apply power, then measure ${net}. Do not take continuity on a powered board.`,
      type: "question",
      probes: [],
      inputLabel: "Powered voltage will be the next reading",
    },
  };
}

function questionStep(title: string, body: string): Step {
  return {
    observation: { title, body },
    hypotheses: [],
    evidence_add: [],
    next_action: { title, body, type: "question", probes: [], inputLabel: "Symptom" },
  };
}

function resolvedStep(
  items: Hypothesis[],
  evidence: string[],
  observation: Step["observation"],
  resolved: Resolved,
): Step {
  return { observation, hypotheses: items, evidence_add: evidence, resolved };
}

function hypotheses(plan: Plan, checking: StageName | null, outcome: "hardware" | "firmware" | "setup" | "plan" | null, keepActive: StageName | null = null): Hypothesis[] {
  const items: Hypothesis[] = [];
  const stages = plan.stages;
  for (const stage of stages) {
    const net = plan.netFor[stage];
    if (!net) continue;
    const id = `h-${stage}`;
    const title = stage === "power"
      ? `${net} is out of window`
      : stage === "divider"
        ? `A resistor on ${net} is faulty`
        : stage === "clock"
          ? `${net} is missing`
          : stage === "reset"
            ? `${net} is stuck`
            : `${net} is stuck`;
    let status: Hypothesis["status"] = "active";
    let confidence = checking === stage ? 0.62 : 0.34;
    if (outcome === "hardware" && checking === stage) {
      status = "confirmed";
      confidence = 0.92;
    } else if (outcome === "hardware" || outcome === "firmware" || outcome === "setup" || outcome === "plan") {
      status = "ruled_out";
      confidence = 0.05;
    } else if (checking) {
      const checkedIndex = stages.indexOf(checking);
      const index = stages.indexOf(stage);
      if (index < checkedIndex && stage !== keepActive) {
        status = "ruled_out";
        confidence = 0.05;
      }
    }
    items.push({
      id,
      title,
      detail: `${net} is the ${stage} net this board exposes for the report.`,
      confidence,
      status,
    });
  }
  if (plan.firmware) {
    const confirmed = outcome === "firmware";
    items.push({
      id: "h-firmware",
      title: "Firmware is not running",
      detail: "Only after power, clock, reset, and a bus are in window.",
      confidence: confirmed ? 0.9 : outcome ? 0.05 : 0.22,
      status: confirmed ? "confirmed" : outcome ? "ruled_out" : "active",
    });
  }
  if (outcome === "setup") {
    items.push({
      id: "h-setup",
      title: "The reading does not match the report",
      detail: "The measured net is inside its window.",
      confidence: 0.84,
      status: "confirmed",
    });
  }
  if (outcome === "plan") {
    items.push({
      id: "h-plan",
      title: "The report does not match the parsed board",
      detail: "A named net or the pad list is missing.",
      confidence: 0.88,
      status: "confirmed",
    });
  }
  return items;
}

function readingLine(reading: Reading): string {
  const where = [reading.target, reading.net].filter(Boolean).join(" ");
  const unit = reading.unit ? ` ${reading.unit}` : "";
  return `${where} = ${formatNum(reading.value)}${unit}`.trim();
}

function formatNum(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1000) / 1000);
}
