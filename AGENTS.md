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
- **Sprint 1 scope:** Run domain, checkpoints, idempotency — no adapters
