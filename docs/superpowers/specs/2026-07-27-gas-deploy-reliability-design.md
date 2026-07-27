# GAS Deploy Reliability Design

## Goal

Make the Google Apps Script deployment workflow manually verifiable and tolerant of short-lived Google OAuth transport failures.

## Scope

Change only `.github/workflows/deploy.yml`. The Apps Script source, runtime triggers, and credentials remain unchanged.

## Triggering

The workflow keeps its existing `push` trigger for `main` and adds `workflow_dispatch` so an operator can run the same deployment job on demand.

## Retry behavior

The `clasp push --force` step attempts deployment at most three times. A failed attempt waits five seconds before the next attempt. A successful attempt exits immediately. If all three attempts fail, the step and workflow remain failed.

This retry is intended for transient failures such as an OAuth token endpoint connection closing early. Persistent errors such as `invalid_grant`, missing secrets, or an invalid script ID remain visible as failures after the third attempt.

## Security

Secrets continue to be injected through GitHub Actions secrets. The workflow must not print token values or write them into repository files.

## Verification

1. Parse the workflow YAML locally.
2. Confirm both `push` and `workflow_dispatch` triggers are present.
3. Confirm the retry loop is bounded to three attempts and returns a non-zero status after three failures.
4. Push the workflow change and invoke it manually.
5. Require a successful `clasp push --force` result from GitHub Actions.

## Non-goals

- Replacing clasp or GitHub Actions.
- Changing the Telegram polling or watchdog implementation.
- Suppressing persistent authentication failures.
