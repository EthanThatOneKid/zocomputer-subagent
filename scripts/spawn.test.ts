import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizationHeader, failedResultCount, parseCliArgs, runBatch, type ParsedOptions } from "./spawn";

test("uses the session identity token unchanged", () => {
  expect(authorizationHeader({ ZO_CLIENT_IDENTITY_TOKEN: "identity-token", ZO_SUBAGENT_API_KEY: "api-key" })).toBe("identity-token");
});

test("adds Bearer to a dedicated API key", () => {
  expect(authorizationHeader({ ZO_SUBAGENT_API_KEY: "api-key" })).toBe("Bearer api-key");
  expect(authorizationHeader({ ZO_SUBAGENT_API_KEY: "Bearer api-key" })).toBe("Bearer api-key");
});

test("parses command-line options", () => {
  const options = parseCliArgs(["--tasks-file", "tasks.txt", "--out", "results.json", "--model", "test:model", "--concurrency", "3", "--timeout-seconds", "30", "--batch-timeout-seconds", "90", "--progress-interval-seconds", "4", "--resume", "--retry-succeeded"]);
  expect(options).toEqual({
    showHelp: false,
    tasksFile: "tasks.txt",
    outputFile: "results.json",
    model: "test:model",
    concurrency: 3,
    timeoutSeconds: 30,
    batchTimeoutSeconds: 90,
    progressIntervalSeconds: 4,
    resumeFile: "results.json",
    retrySucceeded: true,
  });
});

test("supports the help flag", () => {
  expect(parseCliArgs(["-h"]).showHelp).toBe(true);
});

test("counts child failures", () => {
  expect(failedResultCount([
    { index: 0, task_id: "a", task_hash: "a", prompt: "ok", status: "succeeded", attempts: 1, queued_at: "now" },
    { index: 1, task_id: "b", task_hash: "b", prompt: "failed", status: "failed", attempts: 1, queued_at: "now", error: "boom" },
  ])).toBe(1);
});

function options(tasksFile: string, outputFile: string, overrides: Partial<ParsedOptions> = {}): ParsedOptions {
  return {
    showHelp: false,
    tasksFile,
    outputFile,
    model: "test:model",
    concurrency: 2,
    timeoutSeconds: 1,
    batchTimeoutSeconds: 10,
    progressIntervalSeconds: 60,
    retrySucceeded: false,
    ...overrides,
  };
}

async function fixture(tasks: string[]): Promise<{ tasksFile: string; outputFile: string }> {
  const directory = await mkdtemp(join(tmpdir(), "zocomputer-subagent-"));
  const tasksFile = join(directory, "tasks.txt");
  const outputFile = join(directory, "results.json");
  await writeFile(tasksFile, tasks.join("\n"));
  return { tasksFile, outputFile };
}

function response(output: unknown, status = 200): Response {
  return new Response(JSON.stringify({ output, conversation_id: "conversation-test" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function abortableDelay(signal: AbortSignal, milliseconds: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(response("slow")), milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

test("writes successful and failed child results incrementally", async () => {
  const fixtureFiles = await fixture(["first", "second"]);
  let call = 0;
  const observedSnapshots: string[] = [];
  const state = await runBatch(options(fixtureFiles.tasksFile, fixtureFiles.outputFile, { concurrency: 1 }), "test-token", {
    fetch: async (_input, init) => {
      call += 1;
      if (call === 2) observedSnapshots.push(await readFile(fixtureFiles.outputFile, "utf8"));
      return call === 1 ? response("first-result") : response({ error: "bad" }, 400);
    },
    logProgress: () => undefined,
  });
  expect(state.status).toBe("failed");
  expect(state.results.map((result) => result.status)).toEqual(["succeeded", "failed"]);
  expect(state.results[0].output).toBe("first-result");
  expect(state.results[1].attempts).toBe(1);
  expect(JSON.parse(observedSnapshots[0]).results[0].status).toBe("succeeded");
  expect(JSON.parse(await readFile(fixtureFiles.outputFile, "utf8")).results).toHaveLength(2);
});

test("marks a child timed_out when its HTTP request exceeds the child timeout", async () => {
  const fixtureFiles = await fixture(["slow"]);
  const state = await runBatch(options(fixtureFiles.tasksFile, fixtureFiles.outputFile, { timeoutSeconds: 0.05 }), "test-token", {
    fetch: async (_input, init) => abortableDelay(init?.signal as AbortSignal, 500),
    logProgress: () => undefined,
  });
  expect(state.status).toBe("failed");
  expect(state.results[0].status).toBe("timed_out");
  expect(state.results[0].error).toContain("timed out");
  expect(JSON.parse(await readFile(fixtureFiles.outputFile, "utf8")).results[0].status).toBe("timed_out");
});

test("produces a partial file when the overall batch timeout fires", async () => {
  const fixtureFiles = await fixture(["one", "two", "three"]);
  const state = await runBatch(options(fixtureFiles.tasksFile, fixtureFiles.outputFile, {
    concurrency: 2,
    timeoutSeconds: 10,
    batchTimeoutSeconds: 0.05,
  }), "test-token", {
    fetch: async (_input, init) => abortableDelay(init?.signal as AbortSignal, 500),
    logProgress: () => undefined,
  });
  expect(state.status).toBe("partial");
  expect(state.termination_reason).toBe("overall_timeout");
  expect(state.results.filter((result) => result.status === "timed_out")).toHaveLength(2);
  expect(state.results[2].status).toBe("queued");
  expect(state.children_may_still_be_running).toBe(true);
  expect(JSON.parse(await readFile(fixtureFiles.outputFile, "utf8")).status).toBe("partial");
});

test("writes a valid partial file when the runner is cancelled during a concurrent batch", async () => {
  const fixtureFiles = await fixture(["one", "two", "three"]);
  const cancellation = new AbortController();
  setTimeout(() => cancellation.abort(), 20);
  const state = await runBatch(options(fixtureFiles.tasksFile, fixtureFiles.outputFile, {
    concurrency: 2,
    timeoutSeconds: 10,
  }), "test-token", {
    signal: cancellation.signal,
    fetch: async (_input, init) => abortableDelay(init?.signal as AbortSignal, 500),
    logProgress: () => undefined,
  });
  expect(state.status).toBe("partial");
  expect(state.termination_reason).toBe("cancelled");
  expect(state.results.some((result) => result.status === "cancelled")).toBe(true);
  expect(JSON.parse(await readFile(fixtureFiles.outputFile, "utf8")).results).toHaveLength(3);
});

test("resume skips successful tasks and retries incomplete tasks", async () => {
  const fixtureFiles = await fixture(["keep", "retry"]);
  let firstRun = true;
  const first = await runBatch(options(fixtureFiles.tasksFile, fixtureFiles.outputFile, { concurrency: 1 }), "test-token", {
    fetch: async () => {
      if (firstRun) {
        firstRun = false;
        return response("kept");
      }
      return response({ error: "temporary" }, 503);
    },
    logProgress: () => undefined,
  });
  expect(first.results.map((result) => result.status)).toEqual(["succeeded", "failed"]);

  const calls: string[] = [];
  const resumed = await runBatch(options(fixtureFiles.tasksFile, fixtureFiles.outputFile, {
    concurrency: 1,
    resumeFile: fixtureFiles.outputFile,
  }), "test-token", {
    fetch: async (input) => {
      calls.push(String(input));
      return response("retried");
    },
    logProgress: () => undefined,
  });
  expect(calls).toHaveLength(1);
  expect(resumed.results.map((result) => result.status)).toEqual(["succeeded", "succeeded"]);
  expect(resumed.results[0].output).toBe("kept");
  expect(resumed.results[1].output).toBe("retried");
});

test("emits progress while a child is still running", async () => {
  const fixtureFiles = await fixture(["slow"]);
  const progress: string[] = [];
  const state = await runBatch(options(fixtureFiles.tasksFile, fixtureFiles.outputFile, {
    timeoutSeconds: 1,
    progressIntervalSeconds: 0.01,
  }), "test-token", {
    fetch: async (_input, init) => abortableDelay(init?.signal as AbortSignal, 40),
    logProgress: (message) => progress.push(message),
  });
  expect(state.status).toBe("completed");
  expect(progress.some((message) => message.includes("active=1"))).toBe(true);
});
