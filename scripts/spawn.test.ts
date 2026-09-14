import { expect, test } from "bun:test";
import { authorizationHeader, failedResultCount } from "./spawn";

test("uses the session identity token unchanged", () => {
  expect(authorizationHeader({ ZO_CLIENT_IDENTITY_TOKEN: "identity-token", ZO_SUBAGENT_API_KEY: "api-key" })).toBe("identity-token");
});

test("adds Bearer to a dedicated API key", () => {
  expect(authorizationHeader({ ZO_SUBAGENT_API_KEY: "api-key" })).toBe("Bearer api-key");
  expect(authorizationHeader({ ZO_SUBAGENT_API_KEY: "Bearer api-key" })).toBe("Bearer api-key");
});

test("counts child failures", () => {
  expect(failedResultCount([{ index: 0, prompt: "ok" }, { index: 1, prompt: "failed", error: "boom" }])).toBe(1);
});
