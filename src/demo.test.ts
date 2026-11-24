import assert from "node:assert/strict";
import test from "node:test";

import { decide, remember } from "./decide.ts";
import { presentationInput, runPresentation } from "./demo.ts";

test("presentation demo plays one divider fault offline", async () => {
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("presentation demo called the network");
  }) as typeof fetch;
  const key = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  const lines: string[] = [];
  try {
    await runPresentation((line) => lines.push(line));
  } finally {
    globalThis.fetch = previousFetch;
    if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = key;
  }

  const text = lines.join("\n");
  assert.equal(fetches, 0);
  assert.match(lines[0] ?? "", /stand-ins for the bench/);
  assert.match(text, /Problem: The divider should be 1\.65 V and is not\./);
  assert.match(text, /red TP1\.1 · DIV @ 42, 18 mm/);
  assert.match(text, /black TP3\.1 · GND @ 14, 40 mm/);
  assert.match(text, /Moving to 42, 18 mm\./);
  assert.match(text, /Measured 2 V, expected 1\.65 V\./);
  assert.match(text, /red TP2\.1 · 3V3 @ 14, 12 mm/);
  assert.match(text, /black TP3\.1 · GND @ 14, 40 mm/);
  assert.match(text, /Moving to 14, 12 mm\./);
  assert.match(text, /Measured 3\.3 V, expected 3\.3 V\./);
  assert.match(text, /resolved hardware: .*R1 or R2 is faulty\. Replace R1 or R2\./s);
  assert.equal(text.match(/Moving to /g)?.length, 2);
  assert.doesNotMatch(text, /Fixtr|ANTHROPIC|api\.anthropic/i);

  const followUp = text.slice(text.indexOf("Measure 3V3"), text.indexOf("Measured 3.3 V"));
  assert.match(followUp, /\[active\] A resistor on DIV is faulty/);
  assert.doesNotMatch(followUp, /ruled_out\] A resistor/);

  const move1 = text.indexOf("Moving to 42, 18 mm.");
  const measured1 = text.indexOf("Measured 2 V, expected 1.65 V.");
  const move2 = text.indexOf("Moving to 14, 12 mm.");
  const measured2 = text.indexOf("Measured 3.3 V, expected 3.3 V.");
  const resolved = text.indexOf("resolved hardware:");
  assert.ok(move1 >= 0 && move1 < measured1 && measured1 < move2 && move2 < measured2 && measured2 < resolved);
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
