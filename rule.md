# Zo subagent delegation rule

CONDITION: A task contains at least five independent subtasks, or explicitly asks for parallel subagents, fan-out, or a swarm.

INSTRUCTION: Use the zocomputer-subagent workflow when a task contains at least five independent subtasks or explicitly asks for parallel subagents, fan-out, or a swarm. Give each child one narrowly scoped, self-contained task with all required context and an explicit output format; tell each child not to spawn more agents. Limit delegation to five concurrent children and twenty total children. Collect all child results before synthesizing and verifying them in the parent conversation. Do not delegate secrets, irreversible actions, or final external communications. Use the zocomputer-subagent repository's SKILL.md and scripts/spawn.ts, preferring the session-provided ZO_CLIENT_IDENTITY_TOKEN and falling back to a dedicated ZO_SUBAGENT_API_KEY only when configured.
