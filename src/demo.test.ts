import assert from "node:assert/strict";
import test from "node:test";

import { decide, remember } from "./decide.ts";
import { presentationBoard, presentationInput, runPresentation } from "./demo.ts";
import type { Step } from "./types.ts";

test("presentation demo requires an OpenAI key and does not call the network", async () => {
  const openai = process.env.OPENAI_API_KEY;
  const anthropic = process.env.ANTHROPIC_API_KEY;
  const mode = process.env.SB_AI;
  delete process.env.OPENAI_API_KEY;
  process.env.ANTHROPIC_API_KEY = "anthropic-test";
  process.env.SB_AI = "live";
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("presentation demo called the network");
  }) as typeof fetch;
  const lines: string[] = [];
  const errors: string[] = [];
  try {
    const code = await runPresentation((line) => lines.push(line), (line) => errors.push(line));
    assert.equal(code, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = openai;
    if (anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = anthropic;
    if (mode === undefined) delete process.env.SB_AI;
    else process.env.SB_AI = mode;
  }
  assert.equal(fetches, 0);
  assert.deepEqual(lines, []);
  assert.equal(errors[0], "OPENAI_API_KEY is required.");
});

test("presentation demo asks OpenAI and prints the canned divider story", async () => {
  const calls: Array<{ url: string; key: string; body: string }> = [];
  const steps = [probe("Check the divider", "TP1.1", "DIV"), probe("Check the source rail", "TP2.1", "3V3"), cause()];
  await withModel(steps, calls, async () => {
    process.env.SB_AI = "mock";
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await runPresentation((line) => lines.push(line), (line) => errors.push(line));
    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    const text = lines.join("\n");
    assert.match(lines[0] ?? "", /stand-ins for the bench/);
    assert.match(text, /Problem: The divider should be 1\.65 V and is not\./);
    assert.match(text, /Check the divider/);
    assert.match(text, /red TP1\.1 · DIV @ 42, 18 mm/);
    assert.match(text, /Moving to 42, 18 mm\./);
    assert.match(text, /Measured 2 V, expected 1\.65 V\./);
    assert.match(text, /Check the source rail/);
    assert.match(text, /red TP2\.1 · 3V3 @ 14, 12 mm/);
    assert.match(text, /Moving to 14, 12 mm\./);
    assert.match(text, /Measured 3\.3 V, expected 3\.3 V\./);
    assert.match(text, /resolved hardware: R1 or R2 is faulty\. Replace R1 or R2\./);
    assert.equal(text.match(/Moving to /g)?.length, 2);
    assert.doesNotMatch(text, /used the playbook|Fixtr/);
    const move1 = text.indexOf("Moving to 42, 18 mm.");
    const measured1 = text.indexOf("Measured 2 V, expected 1.65 V.");
    const move2 = text.indexOf("Moving to 14, 12 mm.");
    const measured2 = text.indexOf("Measured 3.3 V, expected 3.3 V.");
    const resolved = text.indexOf("resolved hardware:");
    assert.ok(move1 < measured1 && measured1 < move2 && move2 < measured2 && measured2 < resolved);
  });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(call.key, "Bearer test-key");
    const payload = JSON.parse(call.body) as { model?: string };
    assert.equal(payload.model, "gpt-4o-mini");
    assert.equal(call.body.includes("test-key"), false);
  }
  const prompt = userContent(calls[0]?.body ?? "");
  const pads = presentationBoard.pads.map((pad) => `${pad.ref}.${pad.pad}`);
  for (const pad of pads) assert.match(prompt, new RegExp(pad.replace(".", "\\.")));
  assert.doesNotMatch(prompt, /HSE|SWDIO|NRST/);
  assert.match(userContent(calls[1]?.body ?? ""), /"value":2/);
  assert.match(userContent(calls[2]?.body ?? ""), /"value":3\.3/);
});

test("an off-board pad is rejected and Claude is asked once more", async () => {
  const calls: Array<{ url: string; key: string; body: string }> = [];
  const steps = [
    offBoard("Off the board"),
    probe("Check the divider", "TP1.1", "DIV"),
    probe("Check the source rail", "TP2.1", "3V3"),
    cause(),
  ];
  await withModel(steps, calls, async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await runPresentation((line) => lines.push(line), (line) => errors.push(line));
    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    const text = lines.join("\n");
    assert.match(text, /Check the divider/);
    assert.match(text, /Moving to 42, 18 mm\./);
    assert.doesNotMatch(text, /Off the board|used the playbook|Schematic window/);
  });
  assert.equal(calls.length, 4);
});

test("a second off-board pad stops the demo", async () => {
  const calls: Array<{ url: string; key: string; body: string }> = [];
  const steps = [offBoard("Off the board"), offBoard("Still off the board")];
  await withModel(steps, calls, async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await runPresentation((line) => lines.push(line), (line) => errors.push(line));
    assert.equal(code, 1);
    assert.equal(errors[0], "That pad is not on this board.");
    assert.doesNotMatch(lines.join("\n"), /Moving to |used the playbook|Schematic window/);
  });
  assert.equal(calls.length, 2);
});

test("a bad source rail is the fault, not the divider resistor", async () => {
  process.env.SB_AI = "mock";
  const first = await decide(presentationInput());
  const mid = first.next_action?.probes.find((probe) => probe.lead === "red");
  assert.equal(mid?.net, "DIV");
  const secondInput = remember(presentationInput(), first, { value: 2, unit: "V", target: mid?.target, net: "DIV" });
  const second = await decide(secondInput);
  const rail = second.next_action?.probes.find((probe) => probe.lead === "red");
  assert.equal(rail?.net, "3V3");
  const done = await decide(remember(secondInput, second, { value: 2, unit: "V", target: rail?.target, net: "3V3" }));
  assert.equal(done.resolved?.class, "hardware");
  assert.match(done.resolved?.summary ?? "", /3V3/);
  assert.doesNotMatch(done.resolved?.summary ?? "", /Replace/);
});

function userContent(body: string): string {
  const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }> };
  return parsed.messages?.find((message) => message.role === "user")?.content ?? "";
}

function probe(title: string, target: string, net: string): Step {
  return {
    observation: { title, body: title },
    hypotheses: [],
    evidence_add: [],
    next_action: {
      title,
      body: title,
      type: "probe",
      probes: [
        { target, net, lead: "red", kind: "probe", label: `${target} · ${net}` },
        { target: "TP3.1", net: "GND", lead: "black", kind: "probe", label: "TP3.1 · GND" },
      ],
      inputLabel: `Voltage on ${net}`,
      unit: "V",
    },
  };
}

function offBoard(title: string): Step {
  return {
    observation: { title, body: title },
    hypotheses: [],
    evidence_add: [],
    next_action: {
      title,
      body: title,
      type: "probe",
      probes: [
        { target: "TP9.1", net: "5V", lead: "red", kind: "probe", label: "TP9.1 · 5V" },
        { target: "TP9.2", net: "5V", lead: "black", kind: "probe", label: "TP9.2 · 5V" },
      ],
      unit: "V",
    },
  };
}

function cause(): Step {
  return {
    observation: { title: "Divider resistor", body: "The divider is off and the rail is in window." },
    hypotheses: [],
    evidence_add: [],
    resolved: { class: "hardware", summary: "R1 or R2 is faulty. Replace R1 or R2." },
  };
}

async function withModel(
  steps: Step[],
  calls: Array<{ url: string; key: string; body: string }>,
  run: () => Promise<void>,
): Promise<void> {
  const previousFetch = globalThis.fetch;
  const openai = process.env.OPENAI_API_KEY;
  const anthropic = process.env.ANTHROPIC_API_KEY;
  const mode = process.env.SB_AI;
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.ANTHROPIC_API_KEY;
  let index = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const headers = new Headers(init?.headers);
    calls.push({ url: href, key: headers.get("authorization") ?? "", body: String(init?.body ?? "") });
    const step = steps[index];
    index += 1;
    if (!step) throw new Error("presentation demo asked for another model turn");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(step) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = previousFetch;
    if (openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = openai;
    if (anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = anthropic;
    if (mode === undefined) delete process.env.SB_AI;
    else process.env.SB_AI = mode;
  }
}
