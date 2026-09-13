const endpoint = "https://api.zo.computer/zo/ask";
const defaultModel = "openai:gpt-5.6-luna";
const maxChildren = 20;
const maxConcurrency = 5;

function usage(): never {
  console.log(`Usage: bun run scripts/spawn.ts -- --tasks-file <path> --out <path> [--model <model>] [--concurrency <n>] [--timeout-seconds <n>]

Each non-empty line in --tasks-file is sent as one independent child prompt.`);
  process.exit(0);
}

function flag(name: string, fallback = ""): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] || fallback : fallback;
}

function positiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) usage();

const token = process.env.ZO_CLIENT_IDENTITY_TOKEN || process.env.ZO_SUBAGENT_API_KEY;
if (!token) throw new Error("Set ZO_CLIENT_IDENTITY_TOKEN or ZO_SUBAGENT_API_KEY before spawning subagents.");

const tasksFile = flag("--tasks-file");
const outputFile = flag("--out", "subagent-results.json");
const model = flag("--model", defaultModel);
const concurrency = Math.min(positiveInteger(flag("--concurrency", "5"), maxConcurrency), maxConcurrency);
const timeoutSeconds = positiveInteger(flag("--timeout-seconds", "600"), 600);

if (!tasksFile) throw new Error("Missing --tasks-file.");

const tasks = (await Bun.file(tasksFile).text())
  .split(/\r?\n/)
  .map((task) => task.trim())
  .filter(Boolean);

if (tasks.length === 0) throw new Error("The tasks file contains no non-empty prompts.");
if (tasks.length > maxChildren) throw new Error(`Refusing to spawn ${tasks.length} children; the limit is ${maxChildren}.`);

const leafInstruction = "You are a leaf subagent. Do not spawn or delegate to other agents. Complete only the assigned task and return a concise result.";

type Result = {
  index: number;
  prompt: string;
  output?: unknown;
  conversation_id?: string;
  error?: string;
};

async function ask(prompt: string): Promise<{ output: unknown; conversation_id?: string }> {
  let lastError = "Unknown error";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: token,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ input: `${leafInstruction}\n\n${prompt}`, model_name: model }),
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
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

await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
await Bun.write(outputFile, JSON.stringify({ endpoint, model, count: tasks.length, results }, null, 2));
console.log(JSON.stringify({ outputFile, count: tasks.length, succeeded: results.filter((result) => !result.error).length, failed: results.filter((result) => result.error).length }));
