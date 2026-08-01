# Piece of Pi Telegram bridge

## External contract

The daemon uses the Telegram Bot API contracts documented at:

- `getUpdates`: <https://core.telegram.org/bots/api#getupdates>
- `Update`: <https://core.telegram.org/bots/api#update>
- `Message`: <https://core.telegram.org/bots/api#message>
- `PhotoSize`: <https://core.telegram.org/bots/api#photosize>
- `getFile`: <https://core.telegram.org/bots/api#getfile>
- `sendMessage`: <https://core.telegram.org/bots/api#sendmessage>
- `sendChatAction`: <https://core.telegram.org/bots/api#sendchataction>
- `setMyCommands`: <https://core.telegram.org/bots/api#setmycommands>

`telegram.test.ts` encodes the documented private text/photo message shapes. Every valid update ID advances the polling offset even when its payload is unsupported, so one unknown update cannot wedge all later owner messages.

## Trust boundaries and assets

Boundaries:

1. The ragenix token file enters the daemon as secret configuration. It is read only by the service, never logged, returned, or included in process arguments.
2. Telegram update JSON and downloaded photo bytes are untrusted external data. Private text/photo metadata is decoded at the boundary; download paths, media types, image counts, and bytes are bounded before entering the bridge.
3. Sender username and numeric user ID are authentication input. The queued first message must match `@dianov`; its immutable numeric ID is pinned locally. Every later owner message must match both values.
4. Owner text is untrusted message data. It can enqueue only a capability-free `pi-bridge` chat turn; the existing remote tool guard remains authoritative.
5. Bridge responses are bounded before crossing back into Telegram.
6. Pending `ask_user` questions cross from one exact Pi session into the shared SQLite relay. The daemon binds the resulting Telegram `message_id` to that exact `(agent_id, question_id)` pair. Only a private owner message whose `reply_to_message.message_id` matches that binding may answer it.
7. Telegram question replies cross back as bounded answer data. They resolve only the bound pending question. A reply not bound to a live question remains ordinary owner conversation; it never authorizes a tool call.
8. Telegram photos cross into Pi as typed image content only after owner authentication, documented `getFile` decoding, HTTPS download from Telegram's fixed file endpoint, bounded JPEG/PNG/WebP magic-byte detection, declared-type consistency checks, and byte bounds. Generic `application/octet-stream` headers are accepted only when the bytes identify an allowed image. Pixels and captions remain untrusted model data under the zero-tool remote-turn guard.

Assets:

- Telegram bot authority and token confidentiality.
- The pinned owner identity.
- Pi session selection and message queue integrity.
- The invariant that unauthorized Telegram senders never reach `pi-bridge`.
- The invariant that Telegram chat cannot grant Pi tool or process capabilities.

## STRIDE abuse cases

- Spoofing: a different numeric ID presenting username `@dianov` is rejected after owner pinning.
- Tampering: malformed update IDs, sender fields, chat fields, reply references, photo metadata, file paths, media types, and message fields fail in typed decoders. A reply cannot choose its own agent or question ID; Telegram-controlled paths cannot choose a host or local path.
- Repudiation: lifecycle events identify owner pinning, sender rejection, bridge queueing, completion, and failure without message text or personal identifiers.
- Information disclosure: token, message text, username, numeric user ID, session ID, and response text are absent from telemetry.
- Denial of service: Telegram long polling, message/image counts, decoded bytes, progress messages, and SQLite payloads are bounded; every valid update ID advances; transport failures back off before retrying.
- Elevation of privilege: unauthorized messages are rejected before bridge access; authorized remote turns retain the capability-free tool guard. Replies to unknown or terminal question messages fail closed instead of entering ordinary chat.

## Operator questions and signals

One structured JSON event answers each operator question:

1. Is the daemon alive and configured? -> `service_ready` once after token and state load.
2. Are Telegram requests failing? -> `poll_failed` with only the bounded typed error tag.
3. Are non-owners attempting access? -> `sender_rejected`, without sender fields or message content.
4. Did a Pi chat request complete? -> exactly one of `bridge_completed` or `bridge_failed` for the terminal bridge state.
5. Did a pending question reach Telegram and return to Pi? -> `question_relayed` and `question_answered`, with no question text, answer text, owner identifier, or Telegram message ID in telemetry.

Launchd captures stdout and stderr in bounded service log files. No metric or duplicate start/finish log is added.

## First failing tests

- The first private text update from `@dianov` pins its numeric user ID.
- A later update with the same username but another numeric ID is rejected.
- A pinned numeric ID without the current `@dianov` username is rejected.
- Unauthorized messages do not mutate owner state and receive newly composed clanker rejection text.
- Malformed Telegram envelopes fail through `TelegramContractError`.
- A private owner reply decodes only the documented `reply_to_message.message_id` reference.
- A Telegram reply resolves the exact bound `(agent_id, question_id)` and cannot resolve another question.
- Replaying a reply to a terminal question cannot resolve it again; replies not bound to a question continue as ordinary zero-tool owner conversation.
- A documented photo update selects one bounded largest variant; malformed or oversized photo metadata fails closed.
- An unsupported-but-valid update advances the offset instead of wedging later messages.
- A Telegram-controlled file path cannot escape the fixed Telegram file origin, and a download exceeding the byte bound aborts before bridge persistence.

## Non-goals

- Telegram Business connections and business-message automation.
- Arbitrary shell, process, deployment, GitHub, or money-moving capability.
- Group-chat operation or public autoresponder behavior beyond owner rejection.
- LLM-generated rejection messages.
- Secret inspection, token display, or token-bearing diagnostics.
