# Google Business Profile Adapter — Configuration Guide

> Sprint 3 — Production Persistence + First Real Controlled Adapter

## Overview

The Google Business Profile (GBP) adapter enables creating local posts on Google Business profiles via the official API. This guide covers the configuration required for live execution, dry-run mode, and the pilot scope constraints.

---

## Pilot Scope (FP-01)

The production pilot is strictly limited to:

| Constraint | Allowed Value |
|---|---|
| Brand | `best-fluency` |
| Market | `PT` (Portugal) |
| Platform | `google-business` |
| Operation | `createLocalPost` |

Any run request outside this scope is rejected by `checkPilotScope()`.

---

## Environment Variables

### Required for Live Execution

All credentials are loaded exclusively from environment variables. **Never commit `.env` files to the repository.**

```bash
# GCP Project Configuration
GBP_PROJECT_ID=your-gcp-project-id

# OAuth 2.0 Credentials
GBP_OAUTH_CLIENT_ID=your-oauth-client-id
GBP_OAUTH_CLIENT_SECRET=your-oauth-client-secret
GBP_OAUTH_REFRESH_TOKEN=your-oauth-refresh-token

# Business Account Configuration
GBP_ACCOUNT_ID=your-business-account-id
GBP_LOCATION_ID=your-location-id
```

### OAuth 2.0 Setup

1. **Create a GCP Project:**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select an existing one
   - Enable the Google Business Profile API

2. **Create OAuth 2.0 Credentials:**
   - Navigate to APIs & Services → Credentials
   - Create OAuth 2.0 Client ID (type: Web application or Desktop application)
   - Note the Client ID and Client Secret

3. **Obtain Refresh Token:**
   - Use the OAuth 2.0 flow to obtain an authorization code
   - Exchange the authorization code for tokens
   - Store the refresh token securely (it doesn't expire)

4. **Configure Business Account:**
   - `GBP_ACCOUNT_ID`: The Google Business Profile account ID
   - `GBP_LOCATION_ID`: The specific business location ID within the account

### Environment Variables for Pilot Control

```bash
# Enable live pilot execution (opt-in, default: disabled)
LIVE_PILOT_ENABLED=true

# Dry-run storage directories (optional)
FILERUN_STORAGE_DIR=.data/runs
FILECHECKPOINT_STORAGE_DIR=.data/checkpoints
```

---

## Live Pilot Opt-in Gate (FP-02)

Live execution requires **all** of the following conditions:

| Check | Condition | Environment |
|---|---|---|
| `LIVE_PILOT_ENABLED` | Must be `"true"` | Any |
| `NOT_IN_CI` | `CI` and `GITHUB_ACTIONS` must not be `"true"` | CI pipelines |
| `DRY_RUN_EXECUTED` | Dry-run must have been executed successfully | Runtime |

The gate is enforced by `checkLivePilotGate()`. When any check fails:

- `LIVE_PILOT_ENABLED` not set → status `BLOCKED`
- Running in CI → status `BLOCKED_NEEDS_HUMAN`
- Dry-run not executed → status `BLOCKED_NEEDS_HUMAN`

---

## Dry-Run Mode

### What is Dry-Run?

Dry-run mode validates the entire execution pipeline **without making any HTTP requests** to the Google Business Profile API. It is used to verify:

- Payload schema validation
- Credential availability (preflight gate)
- Adapter context construction
- Checkpoint creation
- State machine transitions

### How to Execute Dry-Run

```typescript
import { GoogleBusinessProfileAdapter } from "./google-business-profile-adapter.js";

// Create adapter in dry-run mode
const adapter = new GoogleBusinessProfileAdapter(true); // dryRun = true

// Execute — no HTTP request is sent
const result = await adapter.execute(context);

// Result includes dryRun: true in output
console.log(result.output.dryRun); // true
console.log(result.output.postId); // "dry-run-<runId>"
```

### Dry-Run Properties

| Property | Behavior |
|---|---|
| No HTTP requests | Zero network calls to GBP API |
| Same validation | Payload and credential validation identical to live |
| Simulated output | Returns fake postId with `dry-run-` prefix |
| `dryRun: true` | Always present in output |
| No mutation | No data is created, modified, or deleted on GBP |

### When to Use Dry-Run

- **Before first live execution** (mandatory)
- **After configuration changes** (recommended)
- **In CI pipelines** (always — live is forbidden in CI)
- **For debugging** without affecting production data

---

## Live Smoke Test (FP-03)

### Overview

The live smoke test is a **manual, separate evidentiary process** — never automated in CI. It verifies that the adapter can successfully create a real post on Google Business Profile.

### Prerequisites

1. All environment variables configured (see above)
2. `LIVE_PILOT_ENABLED=true` set
3. Dry-run executed successfully
4. Google Business Profile account verified and active
5. OAuth tokens valid and not expired

### Steps

1. **Verify dry-run passes:**
   ```bash
   # Execute a dry-run first
   npx vitest run automation/adapters/e2e-file-persistence.test.ts
   ```

2. **Set live pilot environment:**
   ```bash
   export LIVE_PILOT_ENABLED=true
   export GBP_PROJECT_ID=...
   export GBP_OAUTH_CLIENT_ID=...
   export GBP_OAUTH_CLIENT_SECRET=...
   export GBP_OAUTH_REFRESH_TOKEN=...
   export GBP_ACCOUNT_ID=...
   export GBP_LOCATION_ID=...
   ```

3. **Execute live test manually:**
   - Create a test post with clearly marked content (e.g., "[SMOKE TEST]...")
   - Verify the post appears in Google Business Profile dashboard
   - Delete the test post after verification

4. **Record evidence:**
   - Screenshot of the post in GBP dashboard
   - Timestamp of creation
   - Post ID returned by the adapter
   - Any errors encountered

### Rollback

If the live smoke test fails or creates unintended data:

1. Delete the test post via GBP dashboard
2. Revoke OAuth tokens if credentials are compromised
3. Set `LIVE_PILOT_ENABLED=false` to disable further live execution
4. Review logs for any error details

### BLOCKED_NEEDS_HUMAN Behavior

When the system cannot proceed with live execution:

- **Missing credentials:** `checkGbpPreflight()` returns `BLOCKED_NEEDS_HUMAN`
- **CI environment:** `checkLivePilotGate()` returns `BLOCKED_NEEDS_HUMAN`
- **Dry-run not executed:** `checkLivePilotGate()` returns `BLOCKED_NEEDS_HUMAN`

In all cases, the system stops and requires manual human intervention. It **never** proceeds automatically without valid configuration.

---

## Adapter Architecture

### GoogleBusinessProfileAdapter

Implements `PlatformAdapter` with two modes:

| Mode | Constructor | Behavior |
|---|---|---|
| Dry-run | `new GoogleBusinessProfileAdapter(true)` | No HTTP, simulated output |
| Live | `new GoogleBusinessProfileAdapter(false)` | Requires credentials, real API calls |

### GbpDryRunAdapter

A standalone dry-run adapter that never makes HTTP calls, regardless of configuration. Used for pipeline validation without any risk of live execution.

### Access Preflight Gate

`checkGbpPreflight()` verifies all required environment variables before any live execution:

| Check | Variable | Description |
|---|---|---|
| AP-01 | `GBP_PROJECT_ID` | GCP project configured |
| AP-02 | `GBP_OAUTH_CLIENT_ID` | OAuth client ID present |
| AP-02 | `GBP_OAUTH_CLIENT_SECRET` | OAuth client secret present |
| AP-02 | `GBP_OAUTH_REFRESH_TOKEN` | OAuth refresh token present |
| AP-03 | `GBP_ACCOUNT_ID` | Business account ID present |
| AP-03 | `GBP_LOCATION_ID` | Business location ID present |

If any check fails, the gate returns `BLOCKED_NEEDS_HUMAN` and the adapter does not proceed.

---

## Security

1. **Credentials in env vars only:** Never in code, config files, or version control
2. **No secrets in logs:** `redactError()` and `redactLog()` sanitize all output
3. **No secrets in records:** RunRecord, Checkpoint, and metadata never contain credentials
4. **Preflight gate:** Blocks execution before any API call is attempted
5. **CI prohibition:** Live execution is forbidden in CI pipelines
