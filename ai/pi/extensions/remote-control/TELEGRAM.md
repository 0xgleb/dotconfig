# Piece of Pi Telegram bridge

## External contract

The daemon uses the Telegram Bot API contracts documented at:

- `getUpdates`: <https://core.telegram.org/bots/api#getupdates>
- `Update`: <https://core.telegram.org/bots/api#update>
- `Message`: <https://core.telegram.org/bots/api#message>
- `sendMessage`: <https://core.telegram.org/bots/api#sendmessage>

`telegram.test.ts` encodes the documented private text-message response shape. The daemon ignores non-message, non-text, bot-authored, and non-private updates.

## Trust boundaries and assets

Boundaries:

1. The ragenix token file enters the daemon as secret configuration. It is read only by the service, never logged, returned, or included in process arguments.
2. Telegram update JSON is untrusted external data. It is decoded into the narrow private-text-message type before routing.
3. Sender username and numeric user ID are authentication input. The queued first message must match `@dianov`; its immutable numeric ID is pinned locally. Every later owner message must match both values.
4. Owner text is untrusted message data. It can enqueue only a capability-free `pi-bridge` chat turn; the existing remote tool guard remains authoritative.
5. Bridge responses are bounded before crossing back into Telegram.

Assets:

- Telegram bot authority and token confidentiality.
- The pinned owner identity.
- Pi session selection and message queue integrity.
- The invariant that unauthorized Telegram senders never reach `pi-bridge`.
- The invariant that Telegram chat cannot grant Pi tool or process capabilities.

## STRIDE abuse cases

- Spoofing: a different numeric ID presenting username `@dianov` is rejected after owner pinning.
- Tampering: malformed update IDs, sender fields, chat fields, and message fields fail in the typed decoder.
- Repudiation: lifecycle events identify owner pinning, sender rejection, bridge queueing, completion, and failure without message text or personal identifiers.
- Information disclosure: token, message text, username, numeric user ID, session ID, and response text are absent from telemetry.
- Denial of service: Telegram long polling and message sizes are bounded; transport failures back off before retrying.
- Elevation of privilege: unauthorized messages are rejected before bridge access; authorized remote turns retain the capability-free tool guard.

## Operator questions and signals

One structured JSON event answers each operator question:

1. Is the daemon alive and configured? -> `service_ready` once after token and state load.
2. Are Telegram requests failing? -> `poll_failed` with only the bounded typed error tag.
3. Are non-owners attempting access? -> `sender_rejected`, without sender fields or message content.
4. Did a Pi chat request complete? -> exactly one of `bridge_completed` or `bridge_failed` for the terminal bridge state.

Launchd captures stdout and stderr in bounded service log files. No metric or duplicate start/finish log is added.

## First failing tests

- The first private text update from `@dianov` pins its numeric user ID.
- A later update with the same username but another numeric ID is rejected.
- A pinned numeric ID without the current `@dianov` username is rejected.
- Unauthorized messages do not mutate owner state and receive newly composed clanker rejection text.
- Malformed Telegram envelopes fail through `TelegramContractError`.

## Non-goals

- Telegram Business connections and business-message automation.
- Arbitrary shell, process, deployment, GitHub, or money-moving capability.
- Group-chat operation or public autoresponder behavior beyond owner rejection.
- LLM-generated rejection messages.
- Secret inspection, token display, or token-bearing diagnostics.
