# zocomputer-subagent

Spawn bounded Zo subagents through the Zo `/ask` API and collect their results in the parent session.

## Install

- `rule.md` is the versioned source for the delegation rule.
- `SKILL.md` is the Zo skill definition.
- `scripts/spawn.ts` is the zero-dependency Bun runner.

The runner prefers the session-provided `ZO_CLIENT_IDENTITY_TOKEN`. A dedicated `ZO_SUBAGENT_API_KEY` is supported as an explicit fallback, but it is not required for normal Zo sessions.

## Run

Put one complete child prompt on each non-empty line of a tasks file, then run:

```sh
bun run scripts/spawn.ts -- --tasks-file /absolute/path/tasks.txt --out /absolute/path/results.json --concurrency 5
```

The runner enforces a maximum of twenty children and five concurrent requests, retries transient failures, tells children not to spawn further agents, preserves result order, and writes every result or error to the JSON output file.
