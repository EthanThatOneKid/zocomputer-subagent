import { expect, test } from "bun:test";
import { authorizationHeader, failedResultCount, parseCliArgs } from "./spawn";

test("uses the session identity token unchanged", () => {
  expect(authorizationHeader({ ZO_CLIENT_IDENTITY_TOKEN: "identity-token", ZO_SUBAGENT_API_KEY: "api-key" })).toBe("identity-token");
});

test("adds Bearer to a dedicated API key", () => {
  expect(authorizationHeader({ ZO_SUBAGENT_API_KEY: "api-key" })).toBe("Bearer api-key");
  expect(authorizationHeader({ ZO_SUBAGENT_API_KEY: "Bearer api-key" })).toBe("Bearer api-key");
});

test("parses command-line options", () => {
  expect(parseCliArgs(["--tasks-file", "tasks.txt", "--out", "results.json", "--model", "test:model", "--concurrency", "3", "--timeout-seconds", "30"])).toEqual({
    showHelp: false,
    tasksFile: "tasks.txt",
    outputFile: "results.json",
    model: "test:model",
    concurrency: 3,
    timeoutSeconds: 30,
  });
});

test("supports the help flag", () => {
  expect(parseCliArgs(["-h"]).showHelp).toBe(true);
});

test("counts child failures", () => {
  expect(failedResultCount([{ index: 0, prompt: "ok" }, { index: 1, prompt: "failed", error: "boom" }])).toBe(1);
});
