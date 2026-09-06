# Webhook Delivery Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the live Telegram webhook and make Worker→GAS delivery failures retryable instead of silently losing updates.

**Architecture:** Telegram must call the Cloudflare Worker, which synchronously calls the GAS Web App and acknowledges only explicit terminal outcomes. GAS owns business processing, reports `processed`/`skipped`/`retry`, records deduplication only after terminal outcomes, and advances polling offset one update at a time.

**Tech Stack:** Google Apps Script V8, Cloudflare Workers ES modules, Node.js 24 built-in test runner, clasp 3.3, Wrangler 4.

**Spec:** `docs/superpowers/specs/2026-09-06-webhook-delivery-reliability-design.md`

## Global Constraints

- Preserve the current Notion database schema and 5 MiB limit.
- Keep `telegram-notion-webhook` as the Worker name and the existing GAS Web App deployment URL.
- Never print or commit generated secrets.
- Do not modify or commit the user's existing `.gitignore` change or unrelated untracked documents.
- Do not acknowledge a retryable update with HTTP 200.
- Do not move `TG_OFFSET` past a retryable failure.

---

### Task 1: Worker delivery contract

**Files:**
- Create: `worker/package.json`
- Create: `worker/test/index.test.mjs`
- Modify: `worker/src/index.js`

**Interfaces:**
- Consumes: `env.GAS_EXEC_URL`, `env.GAS_PROXY_SECRET`, `env.TG_WEBHOOK_SECRET`
- Produces: default Worker module with `fetch(request, env)`; `200` only for GAS terminal outcomes, `503` for retryable delivery failure

- [ ] **Step 1: Write failing Worker behavior tests**

Create tests that invoke the exported Worker's real `fetch` handler with Node `Request` objects. Replace only the external network boundary through an injected `fetchImpl`. Assert these literal outcomes:

```javascript
assert.equal(response.status, 200); // GAS {ok:true,status:'processed'}
assert.equal(response.status, 503); // GAS {ok:false,retry:true}
assert.equal(response.status, 503); // network exception
assert.equal(response.status, 400); // malformed JSON or missing update_id
assert.equal(response.status, 403); // webhook secret mismatch
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test --prefix worker`

Expected: FAIL because the current handler returns 200 before GAS completes and has no injectable network boundary.

- [ ] **Step 3: Implement synchronous forwarding**

Export `createWorker(fetchImpl)` and make the default export use global `fetch`. Parse the Telegram JSON before forwarding. Await the GAS request, require an HTTP 2xx response plus JSON `ok:true`, and return 503 for network errors, non-2xx GAS responses, malformed GAS responses, or `retry:true`.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npm test --prefix worker`

Expected: all Worker tests pass with zero failures.

- [ ] **Step 5: Commit Worker contract**

```bash
git add worker/package.json worker/test/index.test.mjs worker/src/index.js
git commit -m "fix: propagate GAS webhook delivery failures"
```

---

### Task 2: GAS update state machine and polling commits

**Files:**
- Create: `test/gas-contract.test.mjs`
- Modify: `.claspignore`
- Modify: `Code.js`
- Modify: `tests.js`

**Interfaces:**
- Consumes: `processMessage(msg)` returning `{status:'processed'|'skipped'|'retry', reason?:string}`
- Produces: `handleUpdateCore_(update, deps)` and `processPollingBatch_(updates, deps)` with explicit terminal/retry outcomes

- [ ] **Step 1: Write failing GAS contract tests**

Load `Code.js` into a Node VM with complete in-memory implementations of cache, lock, properties, and message processing. Assert:

```javascript
assert.equal(result.retry, true);
assert.deepEqual(cacheWrites, []);          // retry is not marked done
assert.deepEqual(offsetWrites, []);         // retry does not advance offset
assert.deepEqual(offsetWrites, ['102']);    // processed update 101 commits 102
```

Also assert a duplicate terminal update does not call `processMessage` again.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/gas-contract.test.mjs`

Expected: FAIL because `processMessage()` has no result contract, the cache is written before processing, and offset is committed only at batch end.

- [ ] **Step 3: Implement the minimal state machine**

Add pure dependency-driven helpers for update handling and polling. The production wrappers supply `CacheService`, `LockService`, `PropertiesService`, and `processMessage`. Mark cache completion only for `processed` and `skipped`. Stop polling at the first `retry` result and commit each earlier update individually.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
node --test test/gas-contract.test.mjs
npm test --prefix worker
```

Expected: all tests pass.

- [ ] **Step 5: Commit GAS state machine**

```bash
git add .claspignore Code.js tests.js test/gas-contract.test.mjs
git commit -m "fix: retain failed Telegram updates for retry"
```

---

### Task 3: External API classification and safe webhook registration

**Files:**
- Modify: `telegram.js`
- Modify: `notion.js`
- Modify: `utils.js`
- Modify: `webhook.js`
- Modify: `test/gas-contract.test.mjs`

**Interfaces:**
- Produces: `makeApiError_(service, status, body, retryAfter)`, `isRetryableError_(error)`, `validateWebhookUrl_(url)`
- `enableWebhookMode(url, secret)` accepts only HTTPS non-Google Worker URLs and verifies Telegram stored the same URL

- [ ] **Step 1: Extend failing tests**

Assert literal behavior for status 429, 500, 400, missing secrets, `/dev`, and `script.google.com` targets. A 429/5xx error must be retryable; a 400 validation error must not; unsafe webhook URLs must throw before any external request.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/gas-contract.test.mjs`

Expected: FAIL because retry classification and URL validation do not exist.

- [ ] **Step 3: Implement error metadata and webhook guards**

Wrap Telegram and Notion response failures with status and `retryable` metadata. Preserve Notion `Retry-After`. Require a non-empty webhook secret, force `max_connections=1`, and verify `getWebhookInfo.result.url` equals the requested Worker URL.

- [ ] **Step 4: Run all local tests**

Run:

```bash
node --test test/gas-contract.test.mjs
npm test --prefix worker
```

Expected: all tests pass with zero failures.

- [ ] **Step 5: Commit API and configuration guards**

```bash
git add telegram.js notion.js utils.js webhook.js test/gas-contract.test.mjs
git commit -m "fix: reject unsafe webhook configuration"
```

---

### Task 4: Secret migration and deploy synchronization

**Files:**
- Modify: `Code.js`
- Modify: `.github/workflows/deploy.yml`
- Modify: `worker/wrangler.toml`
- Modify: `test/gas-contract.test.mjs`

**Interfaces:**
- Consumes GAS Script Properties: `WEBHOOK_ADMIN_KEY`, `GAS_PROXY_SECRET`
- Produces an authenticated JSON admin POST used for one-time rotation and future webhook enable/status operations

- [ ] **Step 1: Write failing secret/config tests**

Assert production code reads admin and proxy values from the injected property store and rejects missing or mismatched values. Assert the admin POST never includes secrets in its response body.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/gas-contract.test.mjs`

Expected: FAIL while secrets remain source constants.

- [ ] **Step 3: Implement property-backed secrets and deployment workflow**

Use a temporary migration fallback only in the uncommitted deployment used to seed new Script Properties. After rotation, remove the fallback and source constants. Update GitHub Actions to run `clasp version` and redeploy the deployment ID parsed from `worker/wrangler.toml`; add `workflow_dispatch`. Update Worker compatibility date to `2026-09-06`.

- [ ] **Step 4: Run repository safety checks**

Run:

```bash
git grep -n "WEBHOOK_ADMIN_KEY =\|PROXY_SHARED_SECRET ="
git diff --check
node --test test/gas-contract.test.mjs
npm test --prefix worker
```

Expected: secret grep returns no source assignments, diff check succeeds, and all tests pass.

- [ ] **Step 5: Commit synchronization changes**

```bash
git add Code.js .github/workflows/deploy.yml worker/wrangler.toml test/gas-contract.test.mjs
git commit -m "fix: synchronize live GAS webhook deployments"
```

---

### Task 5: Deploy, repair live webhook, and verify end to end

**Files:**
- No additional production source expected

**Interfaces:**
- GAS Web App deployment ID: extracted from `GAS_EXEC_URL`
- Worker: `telegram-notion-webhook`
- Telegram webhook target: `https://telegram-notion-webhook.eyeom40.workers.dev`

- [ ] **Step 1: Create fresh secrets without printing them**

Generate URL-safe random values in memory. Set `GAS_PROXY_SECRET` and `TG_WEBHOOK_SECRET` through Wrangler stdin. Seed matching GAS Script Properties through the temporary authenticated admin POST, then deploy the final source without the legacy fallback.

- [ ] **Step 2: Deploy GAS and Worker**

Run `clasp push --force`, create a numbered Apps Script version, update the existing `worker-proxy` deployment, then run `npx wrangler@latest deploy --config worker/wrangler.toml`.

- [ ] **Step 3: Register and inspect Telegram webhook**

Call the final authenticated admin POST to enable the Worker URL. Read `getWebhookInfo` and require exact Worker URL, no new error, and pending count eventually reaching zero.

- [ ] **Step 4: Verify production behavior**

Require Worker health 200, GAS admin status 200, and observe the pending update leave Telegram. Confirm through logs/status that the update reached a terminal GAS outcome. If the pending document creates a Notion page, do not submit a separate duplicate test document.

- [ ] **Step 5: Synchronize Git and verify clean state**

Merge the isolated branch into local `main`, push `main`, wait for the GitHub Actions deployment, and verify:

```bash
git status -sb
git log --oneline origin/main..HEAD
```

Expected: no unpushed commits; only the user's pre-existing unrelated working-tree changes remain.
