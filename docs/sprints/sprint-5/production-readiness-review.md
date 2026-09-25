# Sprint 5 — Production Readiness Review

> Generated: 2026-09-25
> Sprint: sprint-5 (SQL Server Production Persistence)
> Status: NO-GO

---

## 1. Scope

This review covers the SQL Server persistence layer introduced in
Sprint 5 for VianaHub.Global.Marketing.Ops. The scope includes:

- SQL adapters for RunRepository, CheckpointRepository,
  ScheduleRepository, BatchRepository, and AuditRepository.
- Versioned schema migrations (`database/migrations/`).
- Provider selection and configuration (`persistence-config.ts`).
- FS→SQL import module (`fs-to-sql-import.ts`).
- Recovery integration with SQL Server.
- Optimistic concurrency and idempotency guarantees.
- Operational documentation (`docs/runbook.md` SQL Server section,
  `database/README.md`).

**Out of scope:**

- Identity integration (VianaHub.Global.Identity, `identitydb`,
  `geritdb`).
- Frontend/dashboard changes.
- Public HTTP API.
- Redis or message broker integration.
- Multi-market redesign.
- Advanced analytics or reporting.

---

## 2. Risks

### 2.1 Remaining Security Risks

| ID | Severity | Description | Status |
|---|---|---|---|
| SEC-02 | LOW | Error message redaction gaps in driver-level errors | Open |
| SEC-04 | LOW | Wildcard `npm install mssql *` in lockfile | Open |
| SEC-05 | LOW | `.gitignore` does not exclude `.env.*` broadly | Open |
| SEC-06 | INFO | `npm audit` not yet executed (permission blocked) | Open |
| SEC-07 | INFO | `PERSISTENCE_PROVIDER` echoed in config validation | Open |
| SEC-08 | INFO | Driver lazy-load does not validate module integrity | Open |
| SEC-09 | INFO | `fake-sql-executor.ts` included in non-test build | Open |
| SEC-13 | INFO | No programmatic anti-production guard in integration tests | Open |
| SEC-14 | INFO | `CorruptedRecordError` preserves raw `JSON.parse` cause | Open |
| SEC-15 | INFO | Same raw cause pattern in `sql-schedule-repo.ts` | Open |
| SEC-16 | LOW | `isSqlInput` does not validate SQL identifiers | Open |
| SEC-17 | INFO | `SqlStatement` property `sql:` not covered by AC-36 sweep | Open |
| SEC-18 | LOW | `CorruptedRecordError` in `sql-batch-repo.ts` raw cause | Open |
| SEC-19 | INFO | TOCTOU in post-failure probe heuristics | Open |

### 2.2 Remaining Review Risks

| ID | Severity | Description | Status |
|---|---|---|---|
| REV-05 | LOW | Test name for rollback scenario unclear | Open |
| REV-06 | LOW | Same redactor concern as SEC-02 | Open |
| REV-10 | INFO | Hot-path index evaluation for `findByIdempotencyKey` | Open |
| REV-11 | INFO | Consider index for `listByRunId` on Checkpoints | Open |
| REV-15 | LOW | Probe window between not-found and conflict | Open |
| REV-16..REV-28 | INFO | Various naming, style, and documentation concerns | Open |
| REV-32 | LOW | Collation CI vs JS string comparison | Open |
| REV-33..REV-41 | LOW/INFO | Various minor findings | Open |
| REV-47..REV-52 | LOW/INFO | DDL completeness, public surface, integration scope | Open |
| REV-53..REV-58 | LOW/INFO | Audit limit, cast validation, probe error handling | Open |
| REV-62 | LOW | FS→SQL import AC-48 test coverage | Open |
| REV-64..REV-68 | LOW | Recovery and import minor findings | Open |

### 2.3 External Dependencies

| Dependency | Risk | Mitigation |
|---|---|---|
| `mssql` (npm) | Supply chain, breaking changes | Locked via `package-lock.json`; lazy-loaded |
| SQL Server availability | Production outage | Filesystem fallback; recovery handles interrupted runs |
| GitHub Actions secrets | Credential exposure | Names only in source; secrets never logged |

---

## 3. Infrastructure

### 3.1 Required Infrastructure

| Component | Status | Notes |
|---|---|---|
| SQL Server instance | Required | Production `opsdb` |
| `opsdb` database | Required | Created by DBA; schema via migrations |
| Runtime SQL user | Required | DML-only (least privilege) |
| Migration SQL user | Required | DDL access; only during deployment |
| GitHub Actions secrets | Required | `SQL_SERVER_HOST`, `SQL_SERVER_PORT`, `SQL_SERVER_DATABASE`, `SQL_SERVER_USER`, `SQL_SERVER_PASSWORD` |

### 3.2 CI Infrastructure

| Component | Status | Notes |
|---|---|---|
| `ci.yml` | Unchanged | 5 required checks remain green |
| CodeQL | Pending | GitHub Action on main; not verifiable locally |
| `npm audit` | Blocked by permission | Requires human execution |
| SQL integration tests | Env-gated | Skip when `SQL_INTEGRATION_URL` absent |

### 3.3 Operational Infrastructure

| Component | Status | Notes |
|---|---|---|
| Backup procedure | Documented in `database/README.md` | Human-controlled |
| Migration procedure | Documented in `database/README.md` | Human-controlled, transactional |
| Runbook SQL section | Documented in `docs/runbook.md` | 7 subsections |
| Provider switch | Configuration-driven | `PERSISTENCE_PROVIDER` env var |

---

## 4. Readiness Criteria

| Criterion | Required | Status | Evidence |
|---|---|---|---|
| All 65 ACs have evidence | Yes | 62/65 ATENDIDO | AC-54, AC-58, AC-65 blocked by permission |
| SQL repositories implement contracts | Yes | ATENDIDO | 5 adapters, 1428+ tests passing |
| Filesystem remains supported | Yes | ATENDIDO | Existing FS tests green; default provider |
| Migrations are versioned/validated | Yes | ATENDIDO | `001_initial_schema.sql`, ledger, checksum |
| Isolated SQL integration tests | Yes | ATENDIDO | Env-gated, skip when unavailable |
| Concurrency/idempotency guarantees | Yes | ATENDIDO | Optimistic concurrency, race tests |
| CI remains production-isolated | Yes | ATENDIDO | `ci.yml` unchanged, no opsdb in PR CI |
| No secrets committed | Yes | ATENDIDO | Security reviews: 0 BLOCKER/HIGH |
| Operational documentation complete | Yes | 6/7 complete | AC-58 now ATENDIDO (runbook updated) |
| Quality gates pass | Yes | ATENDIDO | 7/7 gates green (npm audit pending) |
| Security: 0 active Blocker/High/Medium | Yes | ATENDIDO | All HIGH/MEDIUM resolved |
| Reviewer: 0 active Blocker/High/Medium | Yes | ATENDIDO | All HIGH/MEDIUM resolved |
| CodeQL clean | Yes | **PENDING** | Not verifiable locally; requires CI |
| `npm audit` clean | Yes | **PENDING** | Blocked by runtime permission |
| Production-readiness review | Yes | **THIS DOCUMENT** | AC-65 |

---

## 5. Decisions

| ID | Decision | Rationale |
|---|---|---|
| D-01 | Driver `mssql` (tedious), lazy-load, no ORM | Small explicit adapter; compatible with Node.js 24, TypeScript, ESM |
| D-02 | Default `filesystem` provider | Safe backward-compatible default; fail-closed on unknown |
| D-04 | Opção A — no `Revision` in Batches domain | `BatchJob` domain does not expose revision; align JSDoc |
| D-11 | No `UQ_Schedules_IdempotencyKey` | FS backend does not enforce uniqueness; parity preserved |
| D-12 | 4 deliberate FS×SQL divergences | Documented and tested in `repository-contract.test.ts` |
| D-13 | TLS: `encrypt: true`, `trustServerCertificate: false` | Fail-closed; self-signed override requires human decision |
| D-14 | Connection string parameter allowlist | 12 allowed parameters; fail on unknown |
| D-15 | `CorruptedRecordError` preserves raw cause | Defense in depth; sanitized at error boundary |
| D-16 | Redact audit entries before SQL import | Prevent PII/secrets leakage in `AuditEntries.MetadataJson` |

---

## 6. Recommendation: NO-GO

**Sprint 5 completion does NOT automatically imply production GO**
(HUMAN-10, spec Section 25).

### Blocking Criteria

1. **AC-54 (CodeQL):** CodeQL analysis is a GitHub Action that runs on
   the `main` branch. It cannot be verified locally. Until CodeQL
   reports no new Blocker/High security findings attributable to Sprint
   5, production deployment is not authorized.

2. **AC-54 (`npm audit`):** `npm audit --audit-level=high` has not been
   executed due to runtime permission restrictions. Until the audit
   passes with 0 high/critical vulnerabilities, production deployment
   is not authorized.

### Recommendation

**NO-GO** until both AC-54 criteria are satisfied:

1. Execute `npm audit --audit-level=high` in an environment with the
   required permissions. If high/critical vulnerabilities are found,
   remediate before proceeding.
2. Run CodeQL analysis on the `main` branch (or the merge target) and
   verify 0 new Blocker/High findings.
3. After both checks pass, re-evaluate this review for GO decision.

### What Is Ready

- All code implementation is complete (5 SQL adapters, 5 repositories,
  import module, recovery integration).
- 62 of 65 acceptance criteria are ATENDIDO with objective evidence.
- All quality gates pass (format:check, lint, typecheck, test:coverage,
  validate:data, build, git diff --check).
- 0 active BLOCKER/HIGH/MEDIUM findings from security and code review.
- Operational documentation is complete (runbook, database README,
  architecture docs).
- Filesystem provider remains the safe default.
- No production credentials in source.

---

## 7. Limitations

1. **No production database access:** This review was conducted without
   access to a production SQL Server instance. All testing used
   isolated, non-production infrastructure or fake executors.

2. **CodeQL not verified:** CodeQL is a GitHub Action that cannot be
   run locally. The security posture was assessed through manual code
   review and automated testing only.

3. **`npm audit` not executed:** Runtime permission restrictions
   prevented execution of `npm audit --audit-level=high`. The
   dependency security posture is unknown.

4. **Single-developer sprint:** All implementation, testing, and review
   were conducted within the autonomous sprint loop. Independent
   human review is recommended before production deployment.

5. **No load/performance testing:** The SQL adapters were tested for
   correctness and concurrency but not for performance under
   production-like load.

6. **No disaster recovery drill:** The recovery procedures were tested
   via integration tests but not exercised against a real production
   outage scenario.

7. **TLS behavior not validated against production certificates:**
   Default TLS settings (`encrypt: true`, `trustServerCertificate:
   false`) were not tested against a production SQL Server with
   real certificates.

8. **Collation not explicitly addressed:** String comparison behavior
   between JavaScript and SQL Server collation was noted (REV-32 LOW)
   but not explicitly tested in all code paths.

---

## Appendix: Quality Gate Results (Accumulated)

| Gate | Status | Evidence |
|---|---|---|
| `npm run format:check` | PASS | All iterations |
| `npm run lint` | PASS | All iterations |
| `npm run typecheck` | PASS | All iterations |
| `npm run test:coverage` | PASS | 1428+ tests, 8 skip (env-gated) |
| `npm run validate:data` | PASS | All iterations |
| `npm run build` | PASS | All iterations |
| `git diff --check` | PASS | All iterations |
| `npm audit --audit-level=high` | **NOT EXECUTED** | Permission blocked |
| CodeQL | **NOT EXECUTED** | Requires CI |
