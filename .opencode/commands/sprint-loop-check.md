---
description: Verify Sprint 1 custom agent routing without modifying the repository
agent: sprint-orchestrator
subtask: false
---

# Sprint Loop Check

This command is strictly read-only. It must not edit files, run shell commands or tests, update loop-state, access sensitive files, perform Git operations, or read Sprint specifications. Do not use ARGUMENTS or positional parameters. This routing check must never invoke /sprint-loop or start Sprint 1. The sprint-orchestrator may use only the task delegation mechanism required to invoke the five named custom subagents below. Each invoked subagent must not use any tools, read files, run commands, or modify state and must return only its exact AGENT_OK token.

## Identity Gate

The active agent context supplied by the command frontmatter `agent: sprint-orchestrator` is the sole and only allowed identity evidence. Never read AGENTS.md, loop-state.md, Sprint specifications, repository files, configuration files, or environment information to confirm identity. If the active system agent is not clearly sprint-orchestrator, return only `INVALID_ORCHESTRATOR_CONTEXT` without using any tools and stop.

## Tool Budget

During the entire routing check, the orchestrator may make exactly five tool calls total. Every call must use only the task delegation mechanism, once for each custom agent in the exact order listed below. The first tool call must delegate to `sprint-architect`. Explicitly prohibit read, glob, list, grep, bash, edit, write, web, question, todo, skill, Git, shell, tests, and every other tool or operation beyond the five permitted task delegations.

## Agent Routing Verification

Using only the task delegation mechanism, delegate exactly once to each of the following agents in order.

1. `sprint-architect`
2. `sprint-implementer`
3. `sprint-tester`
4. `sprint-security`
5. `sprint-reviewer`

Each subagent must use no tools and return only its exact token:

- `AGENT_OK:sprint-architect`
- `AGENT_OK:sprint-implementer`
- `AGENT_OK:sprint-tester`
- `AGENT_OK:sprint-security`
- `AGENT_OK:sprint-reviewer`

Never use build, general, explore, scout, or fallback agents. Any UI delegation card named General invalidates the check.

## Result

Return `AGENT_ROUTING_PASS` only when the transcript contains exactly the five authorized custom-agent delegation calls, their five exact tokens, and no other tool call.

Return `INVALID_AGENT_ROUTING` if any additional tool call occurs, any file access occurs, any non-task operation occurs, any agent is unavailable, substituted, or missing, any agent returns a different token, or any UI card named General appears.
