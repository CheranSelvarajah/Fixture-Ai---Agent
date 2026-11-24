# FIXTR_AGENT_URL

Noah's Fixtr server keeps `generatePlan`, firmware generation, `applyStep`, and the Investigation screen. This hook replaces only the model call inside `investigationStep` (the `mode: "debug"` path and `POST /api/sessions/:id/investigations`). Leave it off unless `FIXTR_AGENT_URL` is set. Point that at this agent's `POST /decide`, for example `http://127.0.0.1:8787/decide`.

```ts
async function investigationStep(input) {
  const agentUrl = process.env.FIXTR_AGENT_URL;
  if (agentUrl) {
    const response = await fetch(agentUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symptom: input.issue,
        board: input.board,
        readings: input.readings,
        hypotheses: input.hypotheses,
        evidence: input.evidence,
        constraints: input.constraints,
        failedTest: input.failedTest,
      }),
    });
    if (!response.ok) throw new Error(`debug agent ${response.status}`);
    return response.json();
  }
  // existing Anthropic call stays here when the env var is unset
}
```

`generatePlan` is unchanged. No API key is added to the Fixtr request. Set `OPENAI_API_KEY` on this agent process to call OpenAI, or `ANTHROPIC_API_KEY` when that is the only key. OpenAI is used when both are set. With a key set, `POST /decide` investigates: it updates the hypotheses you send and chooses the next pad. `SB_AI=mock` forces the playbook. Send the hypotheses and evidence from the previous step back on the next call, which the snippet above does. The returned object is the one `applyStep` already accepts: `observation`, `hypotheses`, `evidence_add`, and either `next_action` or `resolved`.
