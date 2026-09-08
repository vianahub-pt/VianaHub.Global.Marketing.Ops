# VianaHub Global Marketing Ops - Roadmap

## Current Status

**Version 0.4.0** - Production Foundation (Sprint 0)

## Sprint 0: Production Foundation

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

## Sprint 1: Execution Domain & Idempotency

### Goals

- Create the execution domain before accessing external platforms
- Ensure idempotency
- Allow safe recovery
- Prevent incompatible concurrent executions
- Preserve operational history without storing secrets

### Deliverables

- [ ] `RunId` and `RunRecord`
- [ ] States: `queued`, `running`, `waiting_manual`, `succeeded`, `failed`, `cancelled`
- [ ] State machine with validated transitions
- [ ] Deterministic idempotency key
- [ ] Payload fingerprint without sensitive data
- [ ] `RunStore` interface
- [ ] Local file-based implementation separated from domain rules
- [ ] Atomic checkpoint persistence
- [ ] Concurrency locking
- [ ] Attempt and retry model
- [ ] Error and log redaction
- [ ] `dry-run` mode
- [ ] Unit, integration and failure recovery tests

### Out of Scope

- Real adapters
- External API calls
- Browser automation
- Scheduler
- Dashboard
- Database
- Multi-market activation

## Sprint 2: Adapter Framework & First Controlled Pilot

### Goals

- Integrate the adapter contract with the run domain
- Create a fake/no-op adapter for testing
- Implement a single pilot adapter
- Choose Google Business Profile only if official access and credentials are available
- Support manual/semi-automatic flows
- Never bypass CAPTCHA, MFA or terms of service

### Deliverables

- [x] Initial `PlatformAdapter` interface (baseline)
- [ ] Adapter contract integrated with runs and checkpoints
- [ ] Fake adapter for deterministic end-to-end tests
- [ ] First controlled external adapter
- [ ] Manual-action handoff
- [ ] Status synchronization
- [ ] Adapter-specific security and compliance review

## Sprint 3: Analytics & Reporting

### Goals

- Historical data storage
- Performance metrics
- Trend analysis
- Operational alerts

### Deliverables

- [ ] Historical data storage
- [ ] Trend reports
- [ ] Performance dashboards
- [ ] Alerting system

## Sprint 4: Multi-Market Expansion

### Goals

- Controlled activation of new markets
- Market-specific validations
- Report localization

### Planned Markets

- BR (Brazil) - Secondary priority
- US (United States) - Secondary priority
- ES (Spain) - Secondary priority

## Sprint 5: Scheduling & Batch Automation

### Goals

- Scheduling
- Batch processing
- Operational retries
- Recovery
- Extended auditing

### Deliverables

- [ ] Cron scheduler
- [ ] Batch processing
- [ ] Error recovery
- [ ] Audit logging

## Design Principles

1. **Security First:** All inputs validated, paths secured
2. **Operational Scope:** Only Brand + Market combinations
3. **GERIT Frozen:** Never modify GERIT brand data
4. **Minimal Footprint:** No API, no database, no UI
5. **GitOps Workflow:** All changes via Git commits
6. **Idempotency First:** External operations must be safe to retry
7. **Human in the Loop:** CAPTCHA, authentication and verification may require manual action
8. **No Secrets in Runs:** Runtime records must contain only redacted operational metadata

## Technical Stack

- **Runtime:** Node.js 24 LTS
- **Language:** TypeScript 5.x
- **Validation:** Zod
- **Testing:** Vitest
- **Linting:** ESLint + Prettier
- **CI/CD:** GitHub Actions
- **Code Analysis:** CodeQL
