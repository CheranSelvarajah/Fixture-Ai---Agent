# Noah investigation hook

`FIXTR_AGENT_URL` unset: `investigationStep` stays Noah's. Mock mode and his Anthropic call are unchanged.

`FIXTR_AGENT_URL` set: that function POSTs the session investigation context to this agent's `/decide` and returns that JSON. `applyStep` already accepts it. A probe step has `target` (`ref.pad`), `net`, `x`, and `y`. A resolved step has `resolved.class` plus `resolved.summary` with the cause and the recommended fix.

The extracted GUI with this edit already applied is `/home/ubuntu/noah-fixtr/Fixtr_Capstone-main`. It is not part of this repo. On Windows, copy that folder (or unzip `Fixtr_Capstone-main.zip` and paste the edit below into `GUI_App/server/ai/tasks.ts`). Do not clone `noah-yacowar/Fixtr_Capstone`.

Drop-in for `GUI_App/server/ai/tasks.ts`. Add `Board` to the `shared/types` import and `getBoard` to the `../store` import. Insert the `if (agentUrl)` block at the top of `investigationStep`. Leave `if (aiMode() === "mock")` and the `callTool` below it as they are. Add the four helpers after that function.

```ts
export async function investigationStep(s: Session, inv: Investigation, steer?: string): Promise<InvStep> {
  const agentUrl = process.env.FIXTR_AGENT_URL?.trim();
  if (agentUrl) {
    const board = await getBoard(s.id);
    const response = await fetch(decideUrl(agentUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symptom: [inv.title, s.issue, steer].filter((part) => part && part.trim()).join(". "),
        board: { pads: padsOf(board) },
        readings: readingsOf(inv),
        hypotheses: inv.hypotheses,
        evidence: inv.evidence.map((item) => item.title),
        constraints: { powered: true },
        failedTest: failedTestOf(s, inv),
      }),
    });
    if (!response.ok) throw new Error(`debug agent ${response.status}`);
    return (await response.json()) as InvStep;
  }
  if (aiMode() === "mock") return mock.investigation(s, inv);
  // existing callTool stays here when FIXTR_AGENT_URL is unset
}

function decideUrl(agentUrl: string): string {
  const base = agentUrl.replace(/\/+$/, "");
  return base.endsWith("/decide") ? base : `${base}/decide`;
}

function padsOf(board: Board | undefined) {
  if (!board) return [];
  return board.footprints.flatMap((fp) =>
    fp.pads.flatMap((pad) => (pad.net ? [{ ref: fp.ref, pad: pad.num, net: pad.net, x: pad.x, y: pad.y }] : [])),
  );
}

function readingsOf(inv: Investigation) {
  let probes: Probe[] = [];
  const readings: { value: number; unit?: string; target?: string; net?: string }[] = [];
  for (const entry of inv.timeline) {
    if (entry.action?.probes?.length) probes = entry.action.probes;
    if (entry.kind !== "engineer_result" || entry.value == null) continue;
    const match = String(entry.value).trim().match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/);
    if (!match) continue;
    const red = probes.find((probe) => probe.lead === "red") ?? probes[0];
    readings.push({
      value: Number(match[0]),
      ...(entry.unit ? { unit: entry.unit } : {}),
      ...(red?.target ? { target: red.target } : {}),
      ...(red?.net ? { net: red.net } : {}),
    });
  }
  return readings;
}

function failedTestOf(s: Session, inv: Investigation) {
  const test = inv.testId ? s.plan?.tests.find((item) => item.id === inv.testId) : undefined;
  if (!test) return undefined;
  const red = test.probes.find((probe) => probe.lead === "red") ?? test.probes[0];
  const measured = s.run.results[test.id]?.measured;
  return {
    id: test.id,
    name: test.name,
    ...(test.description ? { description: test.description, checked: test.description } : {}),
    ...(test.purpose ? { purpose: test.purpose } : {}),
    ...(red?.target ? { target: red.target } : {}),
    ...(red?.net ? { net: red.net } : {}),
    ...(test.pass?.min != null ? { min: test.pass.min } : {}),
    ...(test.pass?.max != null ? { max: test.pass.max } : {}),
    ...(test.pass?.unit ? { unit: test.pass.unit } : {}),
    ...(measured ? { measured } : {}),
  };
}
```

## Commands

Two variables on the demo server: `OPENAI_API_KEY` runs the presentation story through live `decide()`. `DEMO_CANNED=1` replays that story without the model (2 V on DIV, 3.3 V on 3V3, then R1 or R2). `DEMO_CANNED=1` wins if both are set. No API key belongs in the repo.

Order: start this server, set `FIXTR_AGENT_URL` to the URL it prints, start his GUI, open an investigation.

From this repo, PowerShell:

```powershell
$env:DEMO_CANNED = "1"
npm run demo:serve
```

The process prints `FIXTR_AGENT_URL=http://127.0.0.1:8787`. For the live path, leave `DEMO_CANNED` unset and set `OPENAI_API_KEY` in that same window before `npm run demo:serve`.

From a copy of `Fixtr_Capstone-main`, PowerShell (install Bun once with `powershell -c "irm bun.sh/install.ps1 | iex"`, then a new terminal):

```powershell
cd GUI_App
bun install
$env:FIXTR_AGENT_URL = "http://127.0.0.1:8787"
bun run start
```

Open http://127.0.0.1:4321 and open an investigation. Enter `2` for DIV, then `3.3` for 3V3.

cmd.exe, same order. Agent repo:

```bat
set DEMO_CANNED=1
npm run demo:serve
```

GUI copy:

```bat
cd GUI_App
bun install
set FIXTR_AGENT_URL=http://127.0.0.1:8787
bun run start
```
