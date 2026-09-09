# VianaHub Global Marketing Ops

## Architecture

- **Runtime:** Node.js 24 LTS
- **Language:** TypeScript 5.x (strict)
- **Validation:** Zod
- **Testing:** Vitest
- **Linting:** ESLint flat config + Prettier
- **CI/CD:** GitHub Actions
- **Code Analysis:** CodeQL

## Quality Gates (execution order)

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm run typecheck      # tsc --noEmit
npm run test:coverage  # Vitest with coverage
npm run validate:data  # Zod schema validation
npm run build          # tsc -p tsconfig.build.json
npm audit --audit-level=high
git diff --check       # whitespace
```

## TypeScript Conventions

- Strict mode enabled
- No `any` types
- Zod for runtime validation
- Atomic file writes (temp + rename)
- `realpathSync` for path security

## Security Policies

- All inputs validated with Zod
- Path traversal protection via `path-security.ts`
- SHA-pinned GitHub Actions
- CodeQL analysis on main
- Dependabot for npm and actions
- No secrets in repository

## Operational Scope

- **Active market:** Portugal (PT) only
- **Brand:** best-fluency (enabled), gerit (frozen)
- **GERIT:** Never modify `brands/gerit/` or `reports/gerit/`
- **Other markets:** Structure exists, `enabled: false`

## Database

- SQL Server planned for future
- No direct frontend access
- Migrations will be versioned

## Agent Loop Rules

- **One writer per working tree:** Only one agent edits code at a time
- **Reviewers always read-only:** Security and reviewer agents never edit
- **No remote Git ops:** No commit, push, merge, or PR without human authorization
- **Application status:** NO-GO for production
- **Sprint 1 scope:** Execution domain & idempotency — no adapters, no FileRunStore

## OpenCode Agent Loop Interface

- **Official interface:** OpenCode Desktop is the official interface for running the agent loop
- **CLI scope:** The CLI is used only for explicitly authorized configuration maintenance and diagnostics
- **Validated baseline:** OpenCode CLI and Desktop version 1.18.30

### Required Procedure

1. Close and reopen Desktop after configuration changes
2. Create a genuinely new blank session
3. Confirm Sprint-Orchestrator is selected automatically
4. Run `/sprint-loop-check`
5. Require the five custom agents in exact order with their exact `AGENT_OK` tokens and final `AGENT_ROUTING_PASS`
6. Invalidate the check if any General, Build, Explore, Scout, fallback, missing, or substituted agent appears
7. Run `/sprint-loop` in the same session immediately after the successful check

### Fail-Closed Results

- `INVALID_ORCHESTRATOR_CONTEXT` — orchestrator context invalid
- `INVALID_AGENT_ROUTING` — agent routing invalid
- `AGENT_ROUTING_REQUIRED` — agent routing required but not satisfied

### Restrictions

- Build may be used only for explicitly authorized agent-configuration maintenance and must never implement Sprint work
- User-level configuration overrides and plugins remain disabled during the controlled Sprint loop

### Evidence Preservation

- `stash@{0}` contains evidence from the invalid execution and must not be applied, deleted, or reused as Sprint output without explicit human authorization
