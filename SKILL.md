---
name: zocomputer-subagent
description: Spawn bounded Zo subagents through the Zo /ask API when a task has independent work or explicitly requests fan-out, then collect and verify every result before synthesizing.
compatibility: Created for Zo Computer
metadata:
  author: etok.zo.computer
---

# zocomputer-subagent

Use this skill for bounded fan-out/fan-in. Prefer the session-provided `ZO_CLIENT_IDENTITY_TOKEN`; use `ZO_SUBAGENT_API_KEY` only when it has been explicitly configured.

Before spawning:

1. Split the work into independent, self-contained child tasks.
2. Give every child all context it needs, one concrete output, and an explicit instruction not to spawn more agents.
3. Do not delegate secrets, irreversible actions, or final external communications.
4. Keep the batch at no more than five concurrent children and twenty total children.

Run `scripts/spawn.ts` with one complete child prompt per line in a tasks file. The runner calls `https://api.zo.computer/zo/ask`, preserves result order, retries transient failures, and writes a JSON result file. Read and verify all results in the parent session before acting on them.
