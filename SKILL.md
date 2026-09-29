---
name: zocomputer-subagent
description: Spawn bounded Zo subagents through the Zo /ask API when a task has independent work or explicitly requests fan-out, then collect and verify every result before synthesizing.
compatibility: Created for Zo Computer
metadata:
  author: etok.zo.computer
---

# zocomputer-subagent

Use this skill for bounded fan-out/fan-in. Prefer the session-provided `ZO_CLIENT_IDENTITY_TOKEN`; use `ZO_SUBAGENT_API_KEY` only when it has been explicitly configured.

The active conversation is the supervisor. The skill can choose a model for each child request, but it cannot change the model of the conversation already running. Keep the parent on a capable model for decomposition, oversight, synthesis, and verification; children are workers, never supervisors.

Before spawning:

1. Split the work into independent, self-contained child tasks and spawn only the minimum set needed.
2. Give every child complete context, one concrete output, an explicit output format, and an instruction not to spawn or delegate.
3. Assign child models by task difficulty using the current `/models/available` catalog: use a `fast` model for narrow, mechanical, easily checked tasks; use a `capable` model for ambiguity, multi-step reasoning, design, code review, or consequential work. Use `model_name="auto"` only when automatic model choice is preferable; it is not a cost cap. Do not hardcode stale model IDs.
4. Do not delegate secrets, irreversible actions, or final external communications.
5. Keep the batch at no more than five concurrent children and twenty total children. Start with the runner's default concurrency of two; stage larger work so the parent can inspect early results before dispatching more.

Use one JSONL task object per line to route models independently, for example `{"prompt":"Extract the dated events from this source and return a table.","model":"<available fast model_name>"}`. Plain-text prompt lines remain supported and use the fallback `--model` (default `auto`). The result file records the requested `model_name` per task; when `auto` is used, it does not report which concrete model Zo selected.

Run `scripts/spawn.ts` with one task per line. The runner starts a separate `/zo/ask` conversation for each child, preserves result order, checkpoints results, and records each returned conversation ID. It defaults to one HTTP attempt per child; raise `--max-attempts` (hard cap three) only when retries are justified. A model timeout or cancellation may occur after Zo accepted the request, so the remote child can keep running. Do not blindly resume timed-out, cancelled, or previously running tasks: inspect the checkpoint and decide whether a duplicate request is acceptable before retrying.

The runner adds a leaf instruction and does not recursively spawn children itself, but `/zo/ask` does not expose a per-child tool allowlist in this flow. Treat the no-delegation instruction as a prompt guard, not a hard security boundary; keep batches small and supervise their results.

Read and verify every result in the parent session before acting on it. Do not fan out again automatically just because a child failed; diagnose the failure and dispatch only the necessary follow-up task.
