import { parseArgs } from "util";

const endpoint = "https://api.zo.computer/zo/ask";
const defaultModel = "openai:gpt-5.6-luna";
const maxChildren = 20;
const maxConcurrency = 5;

type ParsedOptions = {
  showHelp: boolean;
  tasksFile?: string;
  outputFile: string;
  model: string;
  concurrency: number;
  timeoutSeconds: number;
};

export type Result = {
  index: number;
  prompt: string;
  output?: unknown;
  conversation_id?: string;
  error?: string;
};

export function authorizationHeader(env: Record<string, string | undefined> = process.env): string {
  const identityToken = env.ZO_CLIENT_IDENTITY_TOKEN;
  if (identityToken) return identityToken;
  const apiKey = env.ZO_SUBAGENT_API_KEY;
  if (!apiKey) return "";
  return apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;
}

export function failedResultCount(results: readonly Result[]): number {
  return results.filter((result) => Boolean(result.error)).length;
}

function usage(): never {
  console.log(`Usage: bun run scripts/spawn.ts -- --tasks-file <path> --out <path> [--model <model>] [--concurrency <n>] [--timeout-seconds <n>]

Each non-empty line in --tasks-file is sent as one independent child prompt.`);
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
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    showHelp: values.help === true,
    tasksFile: values["tasks-file"],
    outputFile: values.out ?? "subagent-results.json",
    model: values.model ?? defaultModel,
    concurrency: Math.min(positiveInteger(values.concurrency, 5), maxConcurrency),
    timeoutSeconds: positiveInteger(values["timeout-seconds"], 600),
  };
}

async function main() {
  const options = parseCliArgs(Bun.argv.slice(2));
  if (options.showHelp) usage();

  const authorization = authorizationHeader();
  if (!authorization) throw new Error("Set ZO_CLIENT_IDENTITY_TOKEN or ZO_SUBAGENT_API_KEY before spawning subagents.");
  if (!options.tasksFile) throw new Error("Missing --tasks-file.");

  const tasks = (await Bun.file(options.tasksFile).text())
    .split(/\r?\n/)
    .map((task) => task.trim())
    .filter(Boolean);

  if (tasks.length === 0) throw new Error("The tasks file contains no non-empty prompts.");
  if (tasks.length > maxChildren) throw new Error(`Refusing to spawn ${tasks.length} children; the limit is ${maxChildren}.`);

  const leafInstruction = "You are a leaf subagent. Do not spawn or delegate to other agents. Complete only the assigned task and return a concise result.";

  async function ask(prompt: string): Promise<{ output: unknown; conversation_id?: string }> {
    let lastError = "Unknown error";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ input: `${leafInstruction}\n\n${prompt}`, model_name: options.model }),
          signal: AbortSignal.timeout(options.timeoutSeconds * 1000),
        });
        const body = await response.json().catch(() => ({}));
        if (response.ok) return { output: body.output, conversation_id: body.conversation_id };
        lastError = `${response.status} ${response.statusText}: ${JSON.stringify(body)}`;
        if (response.status < 500 && response.status !== 429) break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await Bun.sleep(750 * 2 ** attempt);
    }
    throw new Error(lastError);
  }

  const results: Result[] = Array.from({ length: tasks.length }, (_, index) => ({ index, prompt: tasks[index] }));
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= tasks.length) return;
      try {
        const result = await ask(tasks[index]);
        results[index] = { ...results[index], ...result };
      } catch (error) {
        results[index] = { ...results[index], error: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(options.concurrency, tasks.length) }, worker));
  await Bun.write(options.outputFile, JSON.stringify({ endpoint, model: options.model, count: tasks.length, results }, null, 2));
  const failed = failedResultCount(results);
  console.log(JSON.stringify({ outputFile: options.outputFile, count: tasks.length, succeeded: tasks.length - failed, failed }));
  if (failed > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
