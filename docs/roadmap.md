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

## Sprint 1: External Platform Adapters

### Goals

- Implement adapters for external platforms
- Add semi-automatic registration workflows
- Expand platform coverage

### Planned Platforms

- Google Business Profile (already in progress)
- Facebook Business
- Instagram Business
- LinkedIn Company Pages
- Trustpilot (reviews)

### Deliverables

- [ ] Platform adapter interface
- [ ] Google Business Profile adapter
- [ ] Facebook Business adapter
- [ ] Registration workflow
- [ ] Status synchronization

## Sprint 2: Analytics & Reporting

### Goals

- Enhanced reporting with analytics
- Performance metrics
- Trend analysis

### Deliverables

- [ ] Historical data storage
- [ ] Trend reports
- [ ] Performance dashboards
- [ ] Alerting system

## Sprint 3: Multi-Market Expansion

### Goals

- Enable additional markets
- Add platform catalogs for new markets
- Localize CLI and reports

### Planned Markets

- BR (Brazil) - Secondary priority
- US (United States) - Secondary priority
- ES (Spain) - Secondary priority

## Sprint 4: Automation

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

## Technical Stack

- **Runtime:** Node.js 24 LTS
- **Language:** TypeScript 5.x
- **Validation:** Zod
- **Testing:** Vitest
- **Linting:** ESLint + Prettier
- **CI/CD:** GitHub Actions
- **Code Analysis:** CodeQL
