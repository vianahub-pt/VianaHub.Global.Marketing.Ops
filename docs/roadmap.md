# VianaHub Global Marketing Ops - Roadmap

## Current Status

**Version 0.4.0** - Production Foundation (Sprint 0)

**Application status:** NO-GO for production — awaiting persistence, real controlled adapter, and operational hardening.

## Sprint 0: Production Foundation — CONCLUÍDA

### Goals

- Harden security and input validation
- Implement runtime validation with Zod
- Add CI/CD pipeline with GitHub Actions
- Establish code quality tooling
- Prepare for external platform adapters

### Deliverables

- [x] Zod schemas for all data types
- [x] Path security module
- [x] Hardened CSV parser
- [x] Repository validator
- [x] Atomic report writes
- [x] ESLint + Prettier configuration
- [x] Vitest coverage thresholds
- [x] GitHub Actions CI/CD
- [x] CodeQL analysis
- [x] Dependabot configuration
- [x] SECURITY.md
- [x] CONTRIBUTING.md

## Sprint 1: Execution Domain & Idempotency — CONCLUÍDA

### Goals

- Create the execution domain before accessing external platforms
- Ensure idempotency
- Allow safe recovery
- Prevent incompatible concurrent executions
- Preserve operational history without storing secrets

### Deliverables

- [x] `RunId` and `RunRecord`
- [x] States: `queued`, `running`, `waiting_manual`, `succeeded`, `failed`, `cancelled`
- [x] State machine with validated transitions
- [x] Deterministic idempotency key
- [x] Payload fingerprint without sensitive data
- [x] `RunStore` interface
- [x] Local file-based implementation separated from domain rules
- [x] Atomic checkpoint persistence
- [x] Concurrency locking
- [x] Attempt and retry model
- [x] Error and log redaction
- [x] `dry-run` mode
- [x] Unit, integration and failure recovery tests

## Sprint 2: Adapter Framework & Controlled Fake Pilot — CONCLUÍDA

### Goals

- Integrate the adapter contract with the run domain
- Create a fake/no-op adapter for testing
- Implement execution orchestration with checkpoints
- Support manual/semi-automatic flows
- Never bypass CAPTCHA, MFA or terms of service

### Deliverables

- [x] `PlatformAdapter` interface (adapter contract)
- [x] `FakeAdapter` for deterministic end-to-end tests
- [x] Execution orchestration with checkpoint persistence
- [x] Retry and waiting_manual with resume
- [x] Status synchronization between adapter and run domain
- [x] `AdapterContext` for dependency injection
- [x] `InMemoryRepo` for testing
- [x] E2E, recovery, integration and unit tests
- [x] **No real external adapter in production**

## Sprint 3: Production Persistence + First Real Controlled Adapter

### Goals

- Implement real persistence for RunRepository and checkpoints
- Enable recovery after restart
- Add dry-run mode for real adapters
- Integrate first real external adapter (only via official access and user-provided credentials)
- Secrets only through secure mechanisms, never in payload/logs
- Pilot with Best Fluency / PT market
- Integration, recovery and E2E testing

### Deliverables

- [ ] Real file-based or database RunRepository
- [ ] Checkpoint persistence across restarts
- [ ] Recovery orchestrator for interrupted runs
- [ ] Dry-run mode for real adapters
- [ ] First controlled external adapter (official access only)
- [ ] Secure credential injection (env vars, never logged)
- [ ] Best Fluency / PT pilot integration
- [ ] Integration tests with real adapter
- [ ] Recovery tests after simulated failure
- [ ] E2E tests for full workflow

### Out of Scope for Sprint 3

- Dashboard / frontend
- Multi-market expansion
- Analytics / reporting
- Scheduling / batch processing

## Sprint 4: Scheduling + Observability + Operational Hardening

### Goals

- Cron scheduler for automated runs
- Batch processing support
- Operational monitoring and alerting
- Extended audit logging
- Error recovery automation

### Deliverables

- [ ] Cron scheduler
- [ ] Batch processing
- [ ] Operational monitoring
- [ ] Alerting system
- [ ] Audit logging
- [ ] Error recovery automation

## Sprint 5: Analytics + Reporting + Multi-Market Preparation

### Goals

- Historical data storage and trend analysis
- Performance metrics and dashboards
- Multi-market data structure preparation
- Report localization

### Deliverables

- [ ] Historical data storage
- [ ] Trend reports
- [ ] Performance dashboards
- [ ] Multi-market data structure
- [ ] Report localization

## Post-MVP — Market Expansion

### Goals

- Controlled activation of BR (Brazil) market
- Controlled activation of US (United States) market
- Controlled activation of ES (Spain) market
- Additional international markets as validated

### Planned Markets

- BR (Brazil) — Secondary priority
- US (United States) — Secondary priority
- ES (Spain) — Secondary priority

## Design Principles

1. **Security First:** All inputs validated, paths secured
2. **Operational Scope:** Only Brand + Market combinations
3. **GERIT Frozen:** Never modify GERIT brand data
4. **Minimal Footprint:** No API, no database, no UI (until Post-MVP)
5. **GitOps Workflow:** All changes via Git commits
6. **Idempotency First:** External operations must be safe to retry
7. **Human in the Loop:** CAPTCHA, authentication and verification may require manual action
8. **No Secrets in Runs:** Runtime records must contain only redacted operational metadata
9. **Production First:** Persistence and real adapter before analytics and expansion

## Technical Stack

- **Runtime:** Node.js 24 LTS
- **Language:** TypeScript 5.x
- **Validation:** Zod
- **Testing:** Vitest
- **Linting:** ESLint + Prettier
- **CI/CD:** GitHub Actions
- **Code Analysis:** CodeQL
