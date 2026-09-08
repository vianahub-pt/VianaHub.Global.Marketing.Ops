# Contributing to VianaHub Global Marketing Ops

Thank you for your interest in contributing to VianaHub Global Marketing Ops!

## Getting Started

1. Clone the repository
2. Install dependencies: `npm install`
3. Create a branch: `git checkout -b feature/your-feature`

## Development Workflow

### Prerequisites

- Node.js 24 LTS (check `.nvmrc`)
- npm

### Scripts

```bash
# Run all quality checks
npm run quality

# Run tests
npm run test

# Run tests with coverage
npm run test:coverage

# Run data validation
npm run validate:data

# Run CLI commands
npm run ops -- status --brand best-fluency --market PT
npm run ops -- validate --brand best-fluency --market PT
npm run ops -- report --brand best-fluency --market PT
```

## Code Style

- TypeScript with strict mode
- ESLint for linting
- Prettier for formatting
- Follow existing patterns in the codebase

## Testing

- Write tests for new features
- Maintain or improve coverage (target: 80%+ statements)
- Run `npm run test:coverage` before submitting PRs

## Data Integrity

- All data files are validated by schemas
- Use Zod schemas for runtime validation
- Keep platform catalogs up to date
- Maintain listing status accuracy

## Pull Request Process

1. Ensure all quality checks pass: `npm run quality`
2. Update documentation if needed
3. Add tests for new functionality
4. Request review from repository owner

## Brand Management

### Adding a New Brand

1. Create directory structure under `brands/`
2. Add `master-data.json` with brand profile
3. Add `targets.json` with market configuration
4. Create CSV files for each market
5. Add platform definitions under `data/platforms/`

### Operational Rules

- **Scope:** Only operational scope (Brand + Market)
- **GERIT:** Frozen - never modify `brands/gerit/` or `reports/gerit/`
- **Platforms:** Keep platform catalogs accurate and verified
- **Listings:** Update status only when there's actual change
