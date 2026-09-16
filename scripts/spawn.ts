import { createHash } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "util";

const endpoint = "https://api.zo.computer/zo/ask";
const defaultModel = "openai:gpt-5.6-luna";
const maxChildren = 20;
const maxConcurrency = 5;
const maxAttempts = 3;
const defaultBatchTimeoutSeconds = 1800;
const defaultProgressIntervalSeconds = 10;

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";
export type RunStatus = "running" | "completed" | "partial" | "failed";

export type ParsedOptions = {
  showHelp: boolean;
  tasksFile?: string;
  outputFile: string;
  model: string;
  concurrency: number;
  timeoutSeconds: number;
  batchTimeoutSeconds: number;
  progressIntervalSeconds: number;
  resumeFile?: string;
  retrySucceeded: boolean;
};

export type Result = {
  index: number;
  task_id: string;
  task_hash: string;
  prompt: string;
  status: TaskStatus;
  attempts: number;
  queued_at: string;
  started_at?: string;
  completed_at?: string;
  output?: unknown;
  conversation_id?: string;
  error?: string;
};

export type RunState = {
  version: 1;
  endpoint: string;
  model: string;
  count: number;
  concurrency: number;
  child_timeout_seconds: number;
  batch_timeout_seconds: number;
  status: RunStatus;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  termination_reason?: string;
  children_may_still_be_running: boolean;
  results: Result[];
};

export type RunDependencies = {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  logProgress?: (message: string) => void;
  signal?: AbortSignal;
};

class ChildTimeoutError extends Error {
  constructor() {
    super("Child request timed out.");
    this.name = "ChildTimeoutError";
  }
}

class BatchTimeoutError extends Error {
  constructor() {
    super("Overall batch timeout reached.");
    this.name = "BatchTimeoutError";
  }
}

class RunnerCancelledError extends Error {
  constructor(reason = "Runner cancelled.") {
    super(reason);
    this.name = "RunnerCancelledError";
  }
}

export function authorizationHeader(env: Record<string, string | undefined> = process.env): string {
  const identityToken = env.ZO_CLIENT_IDENTITY_TOKEN;
  if (identityToken) return identityToken;
  const apiKey = env.ZO_SUBAGENT_API_KEY;
  if (!apiKey) return "";
  return apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;
}

export function failedResultCount(results: readonly Result[]): number {
  return results.filter((result) => result.status === "failed" || result.status === "timed_out" || result.status === "cancelled" || Boolean(result.error)).length;
}

function usage(): never {
  console.log(`Usage: bun run scripts/spawn.ts -- --tasks-file <path> --out <path> [options]

Each non-empty line in --tasks-file is sent as one independent child prompt.

Options:
  --timeout-seconds <n>          Per-child HTTP timeout (default: 600)
  --batch-timeout-seconds <n>    Overall batch timeout (default: 1800)
  --progress-interval-seconds <n> Progress interval (default: 10)
  --resume                       Resume from the existing --out file
  --resume-from <path>           Resume from this results file
  --retry-succeeded              Re-run successful tasks while resuming
  --concurrency <n>              Concurrent children, capped at 5
  --model <model>                Zo model name

A resume skips successful tasks by default and retries failed, timed-out, cancelled,
and previously running tasks. The runner aborts its local HTTP requests on timeout or
cancellation; the remote child may continue running if the server already accepted it.`);
  process.exit(0);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseCliArgs(argv: string[]): ParsedOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      "tasks-file": { type: "string" },
      out: { type: "string" },
      model: { type: "string" },
      concurrency: { type: "string" },
      "timeout-seconds": { type: "string" },
      "batch-timeout-seconds": { type: "string" },
      "progress-interval-seconds": { type: "string" },
      resume: { type: "boolean" },
      "resume-from": { type: "string" },
      "retry-succeeded": { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });

  const outputFile = values.out ?? "subagent-results.json";
  return {
    showHelp: values.help === true,
    tasksFile: values["tasks-file"],
    outputFile,
    model: values.model ?? defaultModel,
    concurrency: Math.min(positiveInteger(values.concurrency, 5), maxConcurrency),
    timeoutSeconds: positiveInteger(values["timeout-seconds"], 600),
    batchTimeoutSeconds: positiveInteger(values["batch-timeout-seconds"], defaultBatchTimeoutSeconds),
    progressIntervalSeconds: positiveInteger(values["progress-interval-seconds"], defaultProgressIntervalSeconds),
    resumeFile: values["resume-from"] ?? (values.resume === true ? outputFile : undefined),
    retrySucceeded: values["retry-succeeded"] === true,
  };
}

function timestamp(): string {
  return new Date().toISOString();
}

function taskHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16);
}

function taskId(index: number, prompt: string): string {
  return `task-${index}-${taskHash(prompt)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function sleepWithSignal(milliseconds: number, signal: AbortSignal, sleep: (milliseconds: number) => Promise<void>): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new RunnerCancelledError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason ?? new RunnerCancelledError()));
    signal.addEventListener("abort", onAbort, { once: true });
    void sleep(milliseconds).then(() => finish(resolve), (error) => finish(() => reject(error)));
  });
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await Bun.write(temporaryPath, contents);
  await rename(temporaryPath, path);
}

function normalizeResult(value: Partial<Result>, index: number, prompt: string): Result {
  const status = value.status ?? (value.error ? "failed" : "succeeded");
  const storedPrompt = typeof value.prompt === "string" ? value.prompt : prompt;
  return {
    index,
    task_id: value.task_id ?? taskId(index, storedPrompt),
    task_hash: value.task_hash ?? taskHash(storedPrompt),
    prompt,
    status,
    attempts: value.attempts ?? (status === "queued" ? 0 : 1),
    queued_at: value.queued_at ?? timestamp(),
    started_at: value.started_at,
    completed_at: value.completed_at,
    output: value.output,
    conversation_id: value.conversation_id,
    error: value.error,
  };
}

function progressMessage(state: RunState, startedAtMs: number): string {
  const completed = state.results.filter((result) => ["succeeded", "failed", "timed_out", "cancelled"].includes(result.status)).length;
  const active = state.results.filter((result) => result.status === "running").length;
  const remaining = state.count - completed - active;
  const elapsedSeconds = Math.floor((Date.now() - startedAtMs) / 1000);
  return `[progress] completed=${completed}/${state.count} remaining=${remaining} active=${active} elapsed=${elapsedSeconds}s`;
}

export async function runBatch(options: ParsedOptions, authorization: string, dependencies: RunDependencies = {}): Promise<RunState> {
  if (!options.tasksFile) throw new Error("Missing --tasks-file.");
  if (!authorization) throw new Error("Set ZO_CLIENT_IDENTITY_TOKEN or ZO_SUBAGENT_API_KEY before spawning subagents.");

  const tasks = (await Bun.file(options.tasksFile).text())
    .split(/\r?\n/)
    .map((task) => task.trim())
    .filter(Boolean);
  if (tasks.length === 0) throw new Error("The tasks file contains no non-empty prompts.");
  if (tasks.length > maxChildren) throw new Error(`Refusing to spawn ${tasks.length} children; the limit is ${maxChildren}.`);

  let previous: { results?: Partial<Result>[] } | undefined;
  if (options.resumeFile) {
    const resumePath = options.resumeFile;
    if (!(await Bun.file(resumePath).exists())) throw new Error(`Cannot resume; results file does not exist: ${resumePath}`);
    try {
      previous = JSON.parse(await Bun.file(resumePath).text()) as { results?: Partial<Result>[] };
    } catch (error) {
      throw new Error(`Cannot resume; results file is not valid JSON: ${errorMessage(error)}`);
    }
    if (!Array.isArray(previous.results) || previous.results.length !== tasks.length) {
      throw new Error("Cannot resume; the tasks file does not match the results file count.");
    }
  }

  const startedAt = timestamp();
  const results = tasks.map((prompt, index) => {
    const old = previous?.results?.[index];
    const result = normalizeResult(old ?? {}, index, prompt);
    const sameTask = result.task_hash === taskHash(prompt) && result.prompt === prompt;
    if (!old || !sameTask || result.status !== "succeeded" || options.retrySucceeded) {
      result.status = "queued";
      if (!old || !sameTask) result.attempts = 0;
      result.completed_at = undefined;
      result.started_at = undefined;
      result.error = undefined;
      result.output = undefined;
      result.conversation_id = undefined;
    }
    result.task_id = taskId(index, prompt);
    result.task_hash = taskHash(prompt);
    return result;
  });

  const state: RunState = {
    version: 1,
    endpoint,
    model: options.model,
    count: tasks.length,
    concurrency: Math.min(options.concurrency, tasks.length, maxConcurrency),
    child_timeout_seconds: options.timeoutSeconds,
    batch_timeout_seconds: options.batchTimeoutSeconds,
    status: "running",
    started_at: startedAt,
    updated_at: startedAt,
    children_may_still_be_running: false,
    results,
  };

  let writeQueue = Promise.resolve();
  const persist = async () => {
    state.updated_at = timestamp();
    const snapshot = JSON.stringify(state, null, 2);
    writeQueue = writeQueue.then(() => atomicWrite(options.outputFile, snapshot));
    await writeQueue;
  };

  const logProgress = dependencies.logProgress ?? ((message: string) => console.error(message));
  const startedAtMs = Date.now();
  const sleep = dependencies.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const fetchImpl = dependencies.fetch ?? fetch;
  const batchController = new AbortController();
  let terminationReason: string | undefined;
  let stopError: Error | undefined;
  const signalHandlers: Array<[string, () => void]> = [];

  const requestStop = (reason: string, error: Error) => {
    if (terminationReason) return;
    terminationReason = reason;
    stopError = error;
    batchController.abort(error);
  };

  for (const signalName of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => requestStop(`signal:${signalName}`, new RunnerCancelledError(`Runner cancelled by ${signalName}.`));
    process.on(signalName, handler);
    signalHandlers.push([signalName, handler]);
  }
  if (dependencies.signal) {
    if (dependencies.signal.aborted) requestStop("cancelled", new RunnerCancelledError());
    else {
      const handler = () => requestStop("cancelled", new RunnerCancelledError());
      dependencies.signal.addEventListener("abort", handler, { once: true });
      signalHandlers.push(["external", handler]);
    }
  }

  const overallTimer = setTimeout(() => requestStop("overall_timeout", new BatchTimeoutError()), options.batchTimeoutSeconds * 1000);
  const progressTimer = setInterval(() => logProgress(progressMessage(state, startedAtMs)), options.progressIntervalSeconds * 1000);
  let nextPendingIndex = 0;
  const pendingIndexes = results.map((result, index) => (result.status === "succeeded" ? -1 : index)).filter((index) => index >= 0);

  const ask = async (prompt: string, index: number): Promise<{ output: unknown; conversation_id?: string }> => {
    let lastError = "Unknown error";
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (batchController.signal.aborted) throw batchController.signal.reason ?? new RunnerCancelledError();
      const result = state.results[index];
      result.attempts += 1;
      await persist();
      let childTimedOut = false;
      const childController = new AbortController();
      let onBatchAbort: (() => void) | undefined;
      const timeoutTimer = setTimeout(() => {
        childTimedOut = true;
        childController.abort(new ChildTimeoutError());
      }, options.timeoutSeconds * 1000);
      try {
        onBatchAbort = () => childController?.abort(batchController.signal.reason ?? new RunnerCancelledError());
        batchController.signal.addEventListener("abort", onBatchAbort, { once: true });
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ input: `${leafInstruction}\n\n${prompt}`, model_name: options.model }),
          signal: childController.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (response.ok) return { output: body.output, conversation_id: body.conversation_id };
        lastError = `${response.status} ${response.statusText}: ${JSON.stringify(body)}`;
        if (response.status < 500 && response.status !== 429) break;
      } catch (error) {
        if (childTimedOut) throw new ChildTimeoutError();
        if (batchController.signal.aborted) throw batchController.signal.reason ?? new RunnerCancelledError();
        if (isAbortError(error)) throw error;
        lastError = errorMessage(error);
      } finally {
        clearTimeout(timeoutTimer);
        if (onBatchAbort) batchController.signal.removeEventListener("abort", onBatchAbort);
      }
      if (attempt + 1 < maxAttempts) await sleepWithSignal(750 * 2 ** attempt, batchController.signal, sleep);
    }
    throw new Error(lastError);
  };

  const worker = async () => {
    while (!batchController.signal.aborted) {
      const pendingPosition = nextPendingIndex++;
      if (pendingPosition >= pendingIndexes.length) return;
      const index = pendingIndexes[pendingPosition];
      const result = state.results[index];
      if (batchController.signal.aborted) return;
      result.status = "running";
      result.started_at = timestamp();
      result.completed_at = undefined;
      result.error = undefined;
      await persist();
      logProgress(progressMessage(state, startedAtMs));
      try {
        const childResult = await ask(result.prompt, index);
        result.status = "succeeded";
        result.output = childResult.output;
        result.conversation_id = childResult.conversation_id;
        result.error = undefined;
      } catch (error) {
        if (error instanceof ChildTimeoutError) {
          result.status = "timed_out";
        } else if (error instanceof BatchTimeoutError || terminationReason === "overall_timeout") {
          result.status = "timed_out";
        } else if (error instanceof RunnerCancelledError || terminationReason?.startsWith("signal:") || terminationReason === "cancelled") {
          result.status = "cancelled";
        } else {
          result.status = "failed";
        }
        result.error = errorMessage(error);
      }
      result.completed_at = timestamp();
      await persist();
      logProgress(progressMessage(state, startedAtMs));
    }
  };

  await persist();
  logProgress(progressMessage(state, startedAtMs));
  try {
    await Promise.all(Array.from({ length: state.concurrency }, worker));
  } catch (error) {
    terminationReason ??= "process_failure";
    stopError ??= error instanceof Error ? error : new Error(String(error));
    batchController.abort(stopError);
    for (const result of state.results) {
      if (result.status === "running") {
        result.status = "failed";
        result.error = `Runner failed: ${errorMessage(error)}`;
        result.completed_at = timestamp();
      }
    }
  } finally {
    clearTimeout(overallTimer);
    clearInterval(progressTimer);
    for (const [signalName, handler] of signalHandlers) {
      if (signalName === "external") dependencies.signal?.removeEventListener("abort", handler);
      else process.removeListener(signalName, handler);
    }
  }

  if (terminationReason && stopError) {
    for (const result of state.results) {
      if (result.status === "running") {
        result.status = terminationReason === "overall_timeout" ? "timed_out" : "cancelled";
        result.error = stopError.message;
        result.completed_at = timestamp();
      }
    }
  }
  const incomplete = state.results.some((result) => result.status === "queued" || result.status === "running");
  const failed = failedResultCount(state.results);
  state.status = terminationReason ? "partial" : failed > 0 ? "failed" : "completed";
  state.termination_reason = terminationReason;
  state.finished_at = timestamp();
  state.children_may_still_be_running = state.results.some((result) => result.status === "running" || result.status === "timed_out" || result.status === "cancelled");
  await persist();
  return state;
}

const leafInstruction = "You are a leaf subagent. Do not spawn or delegate to other agents. Complete only the assigned task and return a concise result.";

async function main() {
  const options = parseCliArgs(Bun.argv.slice(2));
  if (options.showHelp) usage();
  const authorization = authorizationHeader();
  const state = await runBatch(options, authorization);
  const failed = failedResultCount(state.results);
  console.log(JSON.stringify({
    outputFile: options.outputFile,
    count: state.count,
    status: state.status,
    succeeded: state.results.filter((result) => result.status === "succeeded").length,
    failed,
    incomplete: state.results.filter((result) => result.status === "queued" || result.status === "running").length,
    termination_reason: state.termination_reason,
    children_may_still_be_running: state.children_may_still_be_running,
  }));
  if (failed > 0 || state.status === "partial") process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
