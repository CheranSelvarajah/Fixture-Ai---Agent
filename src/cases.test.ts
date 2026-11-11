import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { demoBoard, runCase, runMockCases } from "./cases.ts";
import { agentPrompt, decide, polish, remember } from "./decide.ts";
import { fixtrOrigin, loadDecideInput } from "./fixtr.ts";
import { createDecideServer } from "./server.ts";
import type { Step } from "./types.ts";

test("mock cases: dead rail, missing clock, firmware not running", async () => {
  const runs = await runMockCases();
  assert.deepEqual(runs.map((run) => run.fault), ["hardware", "hardware", "firmware"]);
});

test("dead rail lands on the 3V3 test point and includes pad coordinates", async () => {
  process.env.SB_AI = "mock";
  const step = await decide({
    symptom: "The 3V3 rail is dead",
    board: demoBoard,
    constraints: { powered: true },
  });
  const red = step.next_action?.probes.find((probe) => probe.lead === "red");
  const black = step.next_action?.probes.find((probe) => probe.lead === "black");
  assert.equal(step.next_action?.type, "probe");
  assert.equal(step.next_action?.unit, "V");
  assert.equal(red?.target, "TP1.1");
  assert.equal(red?.net, "3V3");
  assert.equal(red?.x, 10);
  assert.equal(red?.y, 20);
  assert.equal(black?.net, "GND");
  assert.equal(black?.x, 10);
  assert.equal(black?.y, 5);
  assert.equal(step.next_action?.probes.filter((probe) => probe.lead === "red").length, 1);
  assert.equal(step.resolved, undefined);
});

test("a healthy rail reading is not called a hardware fault", async () => {
  process.env.SB_AI = "mock";
  const run = await runCase({
    id: "healthy-rail",
    symptom: "The 3V3 rail is dead",
    readings: [{ value: 3.3, unit: "V" }],
    expectNets: ["3V3"],
    expectTarget: "TP1.1",
    expectClass: "setup",
  });
  assert.equal(run.fault, "setup");
});

test("a failed-test window beats the voltage guessed from the net name", async () => {
  process.env.SB_AI = "mock";
  const step = await decide({
    symptom: "The 3V3 rail is dead",
    board: demoBoard,
    readings: [{ target: "TP1.1", net: "3V3", value: 3.1, unit: "V" }],
    failedTest: { net: "3V3", min: 3.2, max: 3.4, unit: "V" },
    constraints: { powered: true },
  });
  assert.equal(step.resolved?.class, "hardware");
});

test("a rail the board does not have is a plan mismatch", async () => {
  process.env.SB_AI = "mock";
  const step = await decide({ symptom: "The 5V rail is dead", board: demoBoard });
  assert.equal(step.resolved?.class, "plan");
  assert.equal(step.next_action, undefined);
});

test("continuity is offered only while the board is unpowered", async () => {
  process.env.SB_AI = "mock";
  const step = await decide({
    symptom: "The 3V3 rail is dead",
    board: demoBoard,
    constraints: { powered: false },
  });
  assert.equal(step.next_action?.unit, "ohm");
  assert.match(step.next_action?.body ?? "", /unpowered/i);
});

test("mass erase is replaced with the playbook probe", async () => {
  process.env.SB_AI = "mock";
  const input = {
    symptom: "The 3V3 rail is dead",
    board: demoBoard,
    constraints: { powered: true },
  };
  const unsafe = {
    observation: { title: "Erase", body: "mass erase the part" },
    hypotheses: [],
    evidence_add: [],
    next_action: {
      title: "Mass erase",
      body: "chip erase",
      type: "command" as const,
      probes: [],
      command: "mass erase",
    },
  };
  const safe = polish(unsafe, input);
  assert.equal(safe.next_action?.command, undefined);
  assert.equal(safe.next_action?.unit, "V");
  assert.equal(safe.next_action?.probes.find((probe) => probe.lead === "red")?.net, "3V3");
});

test("POST /decide returns one probe", async () => {
  process.env.SB_AI = "mock";
  const server = createDecideServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symptom: "HSE clock is missing",
        board: demoBoard,
        constraints: { powered: true },
      }),
    });
    const step = await response.json() as Step;
    assert.equal(response.status, 200);
    assert.equal(step.next_action?.probes.find((probe) => probe.lead === "red")?.net, "3V3");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("fixtr client reads the session symptom and the board pads", async () => {
  const fake = createServer((req, res) => {
    const url = req.url ?? "";
    const body = url.endsWith("/board")
      ? demoBoard
      : url.endsWith("/export.json")
        ? { board: { pads: [] } }
        : { symptom: "The 3V3 rail is dead" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", () => resolve()));
  const address = fake.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const previous = process.env.FIXTR_URL;
  process.env.FIXTR_URL = `http://127.0.0.1:${address.port}`;
  try {
    const input = await loadDecideInput("sess-1");
    assert.equal(input.symptom, "The 3V3 rail is dead");
    assert.equal(input.board.pads.find((pad) => pad.ref === "TP1")?.net, "3V3");
    assert.equal(input.board.pads.find((pad) => pad.ref === "TP1")?.x, 10);
  } finally {
    if (previous === undefined) delete process.env.FIXTR_URL;
    else process.env.FIXTR_URL = previous;
    await new Promise<void>((resolve, reject) => fake.close((error) => error ? reject(error) : resolve()));
  }
});

test("Fixtr client stays on localhost", () => {
  const previous = process.env.FIXTR_URL;
  process.env.FIXTR_URL = "http://127.0.0.1:4321";
  assert.equal(fixtrOrigin(), "http://127.0.0.1:4321");
  process.env.FIXTR_URL = "https://example.com";
  assert.throws(() => fixtrOrigin(), /localhost/);
  if (previous === undefined) delete process.env.FIXTR_URL;
  else process.env.FIXTR_URL = previous;
});

test("the agent prompt keeps the last hypotheses and asks for the separating probe", () => {
  const { system, user } = agentPrompt("playbook text", {
    symptom: "Firmware is not running",
    board: demoBoard,
    hypotheses: [{
      id: "h-clock",
      title: "HSE is missing",
      detail: "Clock not yet measured",
      confidence: 0.6,
      status: "active",
    }],
    evidence: ["3V3 was in window"],
    readings: [{ target: "TP1.1", net: "3V3", value: 3.3, unit: "V" }],
  });
  assert.match(system, /separates your two leading active hypotheses/);
  assert.match(system, /playbook text/);
  assert.match(user, /HSE is missing/);
  assert.match(user, /TP1\.1/);
  assert.match(user, /3V3 was in window/);
});

test("the next turn remembers the hypotheses and the new reading", () => {
  const input = {
    symptom: "The 3V3 rail is dead",
    board: demoBoard,
    readings: [],
    hypotheses: [],
    evidence: [],
  };
  const step = {
    observation: { title: "Measure 3V3", body: "Power first." },
    hypotheses: [{
      id: "h-power",
      title: "3V3 is out of window",
      detail: "Not measured yet",
      confidence: 0.7,
      status: "active" as const,
    }],
    evidence_add: ["Asked for 3V3"],
  };
  const next = remember(input, step, { target: "TP1.1", net: "3V3", value: 0.04, unit: "V" });
  assert.equal(next.hypotheses?.[0]?.id, "h-power");
  assert.deepEqual(next.evidence, ["Asked for 3V3"]);
  assert.equal(next.readings?.[0]?.value, 0.04);
  assert.equal(next.readings?.[0]?.net, "3V3");
});

test("live mode does not invent a step when no key is set", async () => {
  const previous = process.env.SB_AI;
  const key = process.env.ANTHROPIC_API_KEY;
  process.env.SB_AI = "live";
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(
      () => decide({ symptom: "The 3V3 rail is dead", board: demoBoard }),
      /ANTHROPIC_API_KEY/,
    );
  } finally {
    process.env.SB_AI = previous ?? "mock";
    if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = key;
  }
});
