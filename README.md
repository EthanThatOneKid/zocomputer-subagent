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

The runner enforces a maximum of twenty children and five concurrent requests. It retries transient failures, emits progress to stderr, and atomically updates the JSON output after task state changes. Each task record includes a stable task ID/hash, status, attempts, timestamps, output/error, and any returned conversation ID.

Useful controls:

```sh
# Resume from the prior output, skipping successful tasks.
bun run scripts/spawn.ts -- --tasks-file /absolute/path/tasks.txt --out /absolute/path/results.json --resume

# Use a different checkpoint file and retry successful tasks too.
bun run scripts/spawn.ts -- --tasks-file /absolute/path/tasks.txt --out /absolute/path/results.json --resume-from /absolute/path/checkpoint.json --retry-succeeded
```

`--timeout-seconds` bounds each child request. `--batch-timeout-seconds` bounds the whole batch independently. `--progress-interval-seconds` controls periodic progress messages. On cancellation, SIGINT, SIGTERM, per-child timeout, or overall timeout, the runner preserves a valid partial file and records whether remote children may still be running. Resume skips successful tasks; it retries queued, running, failed, timed-out, and cancelled tasks. Because the runner cannot cancel a request already accepted by the remote API, retrying an incomplete task may duplicate remote work; use the stable task ID/hash to reconcile that case. Successful tasks are not rerun unless `--retry-succeeded` is supplied.

Authentication uses `ZO_CLIENT_IDENTITY_TOKEN` unchanged when available. The explicit `ZO_SUBAGENT_API_KEY` fallback is sent as `Bearer <key>`.

Run the focused tests with:

```sh
bun test scripts/spawn.test.ts
```

The runner writes results even when children fail and exits nonzero if any child result contains an error or the batch is partial.
