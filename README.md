# zocomputer-subagent

Spawn bounded Zo subagents through the Zo `/ask` API and collect their results in the parent session. The parent remains responsible for planning, supervision, synthesis, and verification; each child is a leaf worker.

## Model routing

`POST /zo/ask` accepts `model_name` per request, so children in one batch can use different models. The active parent conversation is separate: this skill cannot change its model, so start the parent on a capable model when it must orchestrate and review complex work.

Use one JSONL object per child to set its model:

```jsonl
{"prompt":"Extract explicit dates and names from the supplied source; return a table.","model":"<available fast model_name>"}
{"prompt":"Review the proposed architecture for hidden assumptions and failure modes.","model":"<available capable model_name>"}
```

Choose model IDs from the current `/models/available` catalog rather than hardcoding assumptions: use `fast` for narrow, mechanical, easily checked tasks; use `capable` for ambiguous, multi-step reasoning, design, code review, or high-consequence work. `model_name: "auto"` lets Zo choose a model, but it is not a cost cap. The runner defaults to `auto` for plain-text tasks; set a task's `model` or the batch's `--model` fallback to control it. Results record the requested model name, not the concrete selection behind `auto`.

## Run

Prefer the session-provided `ZO_CLIENT_IDENTITY_TOKEN`. `ZO_SUBAGENT_API_KEY` is supported only as an explicitly configured fallback.

```sh
bun run scripts/spawn.ts -- --tasks-file /absolute/path/tasks.jsonl --out /absolute/path/results.json
```

The runner accepts either one plain-text prompt or one JSONL object (`{"prompt":"...","model":"..."}`) per non-empty line. Each child gets its own `/zo/ask` conversation and the returned `conversation_id` is stored with its result. The `--model` argument is the fallback for tasks without an explicit `model`.

The default concurrency is two, capped at five; the hard limit is twenty children per run. Stage larger work and inspect early outputs before dispatching more. By default, each child gets one HTTP attempt. `--max-attempts <n>` can raise this to at most three, but retries can duplicate accepted work and consume more credits.

Resume skips successful tasks whose prompt and requested model are unchanged. It retries failed, timed-out, cancelled, and previously running tasks. The runner can abort its local HTTP request, but Zo may still be running a request it already accepted. Inspect the checkpoint before resuming timed-out or cancelled work; do not blindly trigger duplicate paid turns. Use `--retry-succeeded` only when intentionally repeating successful work.

The runner adds a leaf instruction and does not recursively spawn children itself, but `/zo/ask` does not expose a per-child tool allowlist in this flow. Treat the no-delegation instruction as a prompt guard, not a hard security boundary; keep batches small and supervise their results.

The runner checkpoints atomically, keeps task order stable, reports progress, and records task IDs, attempts, timestamps, output/errors, requested model, and conversation IDs. It exits nonzero if the run is partial or any child fails.

Run the focused tests with:

```sh
bun test scripts/spawn.test.ts
```
