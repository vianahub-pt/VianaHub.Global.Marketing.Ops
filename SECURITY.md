# Security Policy

## Reporting Security Issues

If you discover a security vulnerability within VianaHub Global Marketing Ops, please send an email to the repository owner. All security vulnerabilities will be promptly addressed.

## Security Best Practices

### Path Security

The CLI validates all `--brand` and `--market` arguments to prevent path traversal attacks:

- Brand IDs must be lowercase kebab-case (e.g., `best-fluency`)
- Market codes must be exactly two uppercase letters (e.g., `PT`)
- Path segments containing `..`, `/`, or `\` are rejected

### Data Validation

All input data is validated using Zod schemas at runtime:

- Brand profiles are validated against `BrandProfileSchema`
- Market targets are validated against `TargetsFileSchema`
- Platform definitions are validated against `PlatformDefinitionSchema`
- CSV listings are validated against `ListingEntrySchema`

### Report Generation

Reports are written atomically using temp files with rename:

1. Write to `<target>.tmp`
2. Rename to final path
3. Cleanup temp file on error

This prevents corrupted reports from partial writes.

### CI/CD Security

- GitHub Actions use SHA-pinned versions with version comments
- `Quality Checks` runs on pushes and pull requests to `main` and `develop`
- CodeQL analysis runs on pushes and pull requests to `main`, plus a weekly schedule
- Dependabot is configured for both npm and GitHub Actions dependencies

### Sensitive Data

- No API keys or secrets are stored in the repository
- Future external platform adapters must receive credentials exclusively through environment variables or an approved secret manager
- No external platform credentials are currently required by the implemented core
