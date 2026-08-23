# Pi request observability

The request lifecycle log exists to answer four operator questions without
reading session content or credential material.

| Operator question | Signal |
| --- | --- |
| Which lifecycle phase did a request enter last, and how long ago? | `pi.request.phase` structured log event with `requestId`, `phase`, `elapsedMs`, and `pid`. |
| Is authentication waiting on credential read, lock acquisition, refresh, or auth derivation? | `pi.auth.phase` structured log event with `requestId`, `phase`, `elapsedMs`, and a bounded `failureClass` on failure. |
| Did provider admission complete and did transport dispatch begin? | `pi.provider.phase` structured log event with `requestId`, `phase`, `provider`, and `model`. |
| Did the request complete, fail, or abort, and after how long? | `pi.request.outcome` structured log event with `requestId`, `outcome`, `elapsedMs`, and a bounded `failureClass`. |

Logs are JSON Lines under `$XDG_STATE_HOME/pi/logs/`, falling back to
`~/.local/state/pi/logs/`. Each process writes its own
`request-lifecycle-<pid>.jsonl` file.

The lifecycle schema must never contain prompts, messages, payloads, headers,
URLs, credential values, access or refresh tokens, environment values, or raw
provider error messages. Provider and model identifiers are allowed. Request
identifiers are correlation fields, never metric labels.
