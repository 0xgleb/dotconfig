# Task tests

## Required host

The SDK-backed tests, including `tool.test.ts`, require the configured Pi host
installed with `pi` on `PATH`. Its matching
`lib/node_modules/pi-monorepo/dist/bundle/index.js` must be available relative
to the resolved executable. These tests load that host before registering cases;
a missing host is a missing test prerequisite, not a passing or skipped suite.

The Node version must support TypeScript stripping and `node:sqlite`, and the
extension package's development dependencies must be available. From the
repository root, run:

```sh
node --experimental-strip-types --test ai/pi/extensions/issue-tasks/tool.test.ts
```

`PI_ISSUE_TASK_GITHUB_LIVE_READ_TESTS` controls only live GitHub reads.
Disabling it does not remove the Pi host prerequisite or skip the offline SDK
tests.
