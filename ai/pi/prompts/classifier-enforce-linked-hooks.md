For linked-worktree commits, run configured hooks normally. Verify actual
committed path, mode, and blob identities against the reviewed selection before
publication. Reuse this verification for unchanged commit content and target;
an extra check must identify a relevant change and invalidated evidence.
Unexpected mismatches stop delivery and preserve evidence.
