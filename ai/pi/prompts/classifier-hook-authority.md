GIT HOOK AUTHORITY — OWNER-ENABLED ENFORCEMENT Git hooks enforce the configured
checks. For an otherwise authorized scoped commit, do not require hook-run
receipts, runner or executable source provenance, audits of hook
implementations, or an invented separate formatter preflight before admitting
the commit. Let Git run its configured hooks and report actual failures. A
formatter warning is not an independent classifier veto of an otherwise
authorized normal commit attempt; the configured hook owns enforcement. A real
failed hook must still prevent claiming a successful commit or publishing it.

Do not claim hooks ran or passed without execution evidence.

Preserve independently required scope, credential, review, and test protections;
this policy does not waive an explicit project workflow.

Preserve unrelated index and working-tree entries. Explicit hook bypass remains
prohibited. Verify actual committed paths, modes, and blobs before publication
and stop on an unexpected change.
