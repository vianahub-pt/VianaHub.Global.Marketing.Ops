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

## Sprint 1: Execution Domain, Checkpoints & Idempotency

### Goals

- Establish a reliable execution domain before integrating external platforms
- Make every operation traceable, resumable, and idempotent
- Prevent duplicate or concurrent execution of the same operation
- Keep runtime data and credentials outside Git

### Deliverables

- [ ] Run identifier and deterministic idempotency key
- [ ] Run state machine with validated transitions
- [ ] Run record containing brand, market, platform, operation, attempt, timestamps and result
- [ ] Run store interface independent from persistence technology
- [ ] Atomic filesystem run store for the initial implementation
- [ ] Checkpoint persistence and resume support
- [ ] Execution locking and concurrency protection
- [ ] Retry policy contract with bounded attempts
- [ ] Dry-run execution mode
- [ ] Error classification and sensitive-data redaction
- [ ] Unit, integration and recovery tests
- [ ] Operational documentation

### Out of Scope

- Real external platform adapters
- Scheduled execution
- Database
- Web interface
- Multi-market activation

## Sprint 2: Adapter Framework & First Controlled Integration

### Goals

- Connect adapters to the execution and checkpoint domain
- Validate the complete workflow with a controlled pilot
- Keep manual intervention available for CAPTCHA, login and verification

### Deliverables

- [x] Initial platform adapter interface
- [ ] Adapter contract integrated with runs and checkpoints
- [ ] Fake adapter for deterministic end-to-end tests
- [ ] First controlled external adapter
- [ ] Manual-action handoff
- [ ] Status synchronization
- [ ] Adapter-specific security and compliance review

## Sprint 3: Analytics & Reporting

### Goals

- Enhanced reporting with analytics
- Performance metrics
- Trend analysis

### Deliverables

- [ ] Historical data storage
- [ ] Trend reports
- [ ] Performance dashboards
- [ ] Alerting system

## Sprint 4: Multi-Market Expansion

### Goals

- Enable additional markets
- Add platform catalogs for new markets
- Localize CLI and reports

### Planned Markets

- BR (Brazil) - Secondary priority
- US (United States) - Secondary priority
- ES (Spain) - Secondary priority

## Sprint 5: Advanced Automation

### Goals

- Advanced automation workflows
- Scheduled tasks
- Batch operations

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
