# Live Smoke Test — Google Business Profile

> Sprint 3 — Production Persistence + First Real Controlled Adapter

## Overview

The live smoke test is a **manual, separate evidentiary process** that verifies the Google Business Profile adapter can successfully create a real post. It is **never automated in CI** and is **never required for CI to pass**.

This test produces human-verifiable evidence that the full stack works end-to-end with real credentials and real API access.

---

## Prerequisites

### Environment Configuration

All of the following environment variables must be set:

```bash
# GCP Project
GBP_PROJECT_ID=<your-project-id>

# OAuth 2.0 Credentials
GBP_OAUTH_CLIENT_ID=<your-client-id>
GBP_OAUTH_CLIENT_SECRET=<your-client-secret>
GBP_OAUTH_REFRESH_TOKEN=<your-refresh-token>

# Business Account
GBP_ACCOUNT_ID=<your-account-id>
GBP_LOCATION_ID=<your-location-id>

# Pilot Control
LIVE_PILOT_ENABLED=true
```

### Pre-flight Checks

Before executing the live smoke test:

1. **Dry-run must pass:**
   ```bash
   npx vitest run automation/adapters/e2e-file-persistence.test.ts
   ```
   Verify all tests pass, especially the dry-run verification tests.

2. **Preflight gate must pass:**
   ```bash
   npx vitest run automation/adapters/access-preflight-gate.test.ts
   ```

3. **OAuth tokens must be valid:**
   - Verify refresh token is not expired
   - Test token refresh if possible

4. **GBP account must be active:**
   - Verify business profile is claimed and verified
   - Verify location ID is correct

---

## Test Steps

### Step 1: Prepare Test Content

Create a clearly identifiable test post:

```
Summary: "[SMOKE TEST] VianaHub Marketing Ops — Automated test post. Please ignore."
Call to Action: LEARN_MORE
URL: https://example.com
```

**Important:** Mark the post clearly as a smoke test so it can be identified and deleted.

### Step 2: Execute Live Test

```typescript
import { GoogleBusinessProfileAdapter } from "./google-business-profile-adapter.js";
import { buildAdapterContext } from "./adapter-context.js";
import type { RunRecord } from "../domain/run-record.js";

// Build a test run record
const testRecord: RunRecord = {
  schemaVersion: 1,
  runId: "smoke-test-0001" as RunId,
  brandId: "best-fluency",
  market: "PT",
  platform: "google-business",
  operation: "createLocalPost",
  state: "queued",
  attempt: 0,
  maxAttempts: 1,
  idempotencyKey: "a".repeat(64) as IdempotencyKey,
  payloadFingerprint: "b".repeat(64) as PayloadFingerprint,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const adapter = new GoogleBusinessProfileAdapter(false); // Live mode
const context = buildAdapterContext(testRecord);

const result = await adapter.createLocalPost(context, {
  summary: "[SMOKE TEST] VianaHub Marketing Ops — Automated test post. Please ignore.",
  callToAction: "LEARN_MORE",
  url: "https://example.com",
});
```

### Step 3: Verify Result

Check that the adapter returns a successful result:

```typescript
console.log("Post ID:", result.postId);
console.log("Summary:", result.summary);
console.log("Dry Run:", result.dryRun); // Should be false
```

### Step 4: Verify in GBP Dashboard

1. Log in to [Google Business Profile Manager](https://business.google.com/)
2. Navigate to the business profile for the test location
3. Find the test post (look for "[SMOKE TEST]" prefix)
4. Verify the post content matches expectations

### Step 5: Record Evidence

Document the following evidence:

| Evidence | Value |
|---|---|
| Timestamp | `<ISO-8601 timestamp>` |
| Post ID | `<returned postId>` |
| Summary | `<post summary>` |
| GBP Dashboard Screenshot | `<attached>` |
| Environment | `<node version, OS>` |
| Any Errors | `<error details or "None">` |

### Step 6: Cleanup

**Delete the test post** after verification:

1. In GBP Dashboard, find the test post
2. Click the delete/remove option
3. Confirm deletion
4. Verify the post is no longer visible

---

## Rollback Procedures

### If the Test Post Cannot Be Deleted

1. Mark the post as a test in the GBP dashboard
2. Contact the business profile owner to remove it
3. Document the issue for future reference

### If Credentials Are Compromised

1. Immediately revoke the OAuth tokens in GCP Console
2. Set `LIVE_PILOT_ENABLED=false`
3. Generate new OAuth credentials
4. Update environment variables
5. Re-execute the dry-run before any further live tests

### If the Adapter Produces Errors

1. Check the error message for `BLOCKED_NEEDS_HUMAN`
2. Verify all environment variables are set correctly
3. Check OAuth token validity
4. Review GBP API quotas and limits
5. Check GCP project API enablement

---

## BLOCKED_NEEDS_HUMAN Behavior

The system is designed to stop and require human intervention in the following scenarios:

| Scenario | Gate | Status |
|---|---|---|
| `LIVE_PILOT_ENABLED` not set | `checkLivePilotGate()` | `BLOCKED` |
| Running in CI | `checkLivePilotGate()` | `BLOCKED_NEEDS_HUMAN` |
| Dry-run not executed | `checkLivePilotGate()` | `BLOCKED_NEEDS_HUMAN` |
| Missing credentials | `checkGbpPreflight()` | `BLOCKED_NEEDS_HUMAN` |
| Invalid OAuth tokens | `checkGbpPreflight()` | `BLOCKED_NEEDS_HUMAN` |

In all cases, the system **never** proceeds automatically. Manual human action is required to resolve the blocking condition.

---

## CI Policy

- **Live execution is forbidden in CI pipelines** (FP-02)
- **Dry-run is always executed in CI** (safe, no HTTP calls)
- **Live smoke test is separate manual evidence** (FP-03)
- **No live credentials in CI environment variables**

The CI pipeline runs:
1. `format:check` — Prettier formatting
2. `lint` — ESLint rules
3. `typecheck` — TypeScript type checking
4. `test:coverage` — Vitest unit/integration tests
5. `validate:data` — Zod schema validation
6. `build` — TypeScript compilation
7. `git diff --check` — Whitespace validation

None of these steps make live API calls.

---

## Troubleshooting

### "BLOCKED_NEEDS_HUMAN" from Preflight Gate

**Cause:** One or more required environment variables are missing.

**Solution:** Verify all `GBP_*` environment variables are set and non-empty.

### "BLOCKED" from Live Pilot Gate

**Cause:** `LIVE_PILOT_ENABLED` is not set to `"true"`.

**Solution:** Set `LIVE_PILOT_ENABLED=true` in your environment.

### "LIVE_NOT_IMPLEMENTED" from Adapter

**Cause:** The adapter's live execution path is not yet connected to the real GBP API.

**Solution:** This is expected during the pilot phase. The adapter returns this error when `dryRun=false` and real API integration is not yet active.

### OAuth Token Expired

**Cause:** The refresh token has expired or been revoked.

**Solution:** Generate new OAuth credentials and update environment variables.
