# Piece of Pi Telegram bridge

## External contract

The daemon uses the Telegram Bot API contracts documented at:

- `getUpdates`: <https://core.telegram.org/bots/api#getupdates>
- `Update`: <https://core.telegram.org/bots/api#update>
- `Message`: <https://core.telegram.org/bots/api#message>
- `PhotoSize`: <https://core.telegram.org/bots/api#photosize>
- `Voice`: <https://core.telegram.org/bots/api#voice>
- `getFile`: <https://core.telegram.org/bots/api#getfile>
- `sendMessage`: <https://core.telegram.org/bots/api#sendmessage>
- `sendChatAction`: <https://core.telegram.org/bots/api#sendchataction>
- `setMessageReaction`: <https://core.telegram.org/bots/api#setmessagereaction>
- `setMyCommands`: <https://core.telegram.org/bots/api#setmycommands>

`telegram.test.ts` encodes the documented private text/photo/voice message shapes. Every valid update ID advances the polling offset even when its payload is unsupported, so one unknown update cannot wedge all later owner messages.

## Trust boundaries and assets

Boundaries:

1. The ragenix token file enters the daemon as secret configuration. It is read only by the service, never logged, returned, or included in process arguments.
2. Telegram update JSON and downloaded photo bytes are untrusted external data. Private text/photo metadata is decoded at the boundary; download paths, media types, image counts, and bytes are bounded before entering the bridge. A two-second bounded drain window coalesces at most eight adjacent ordinary messages from the same sender into one turn; commands, replies, a second image, and the bridge text limit are hard boundaries. The persisted update offset advances to the final coalesced update only after handling succeeds or reports a typed failure.
3. Sender username and numeric user ID are authentication input. The queued first message must match `@dianov`; its immutable numeric ID is pinned locally. Every later owner message must match both values.
4. Owner text is untrusted message data. It can enqueue only a capability-free `pi-bridge` chat turn; the existing remote tool guard remains authoritative.
5. Bridge responses are bounded before crossing back into Telegram.
6. Pending `ask_user` questions cross from one exact Pi session into the shared SQLite relay. The daemon binds the resulting Telegram `message_id` to that exact `(agent_id, question_id)` pair. Only a private owner message whose `reply_to_message.message_id` matches that binding may answer it. Telegram renders a human-readable project/session label plus the source-fixed active registry role; duplicate labels get deterministic instance numbers. Raw session-ID prefixes remain available only in `/agents` diagnostics and never act as authentication or authority.
7. Telegram question replies cross back as bounded answer data. They resolve only the bound pending question. A reply not bound to a live question remains ordinary owner conversation; it never authorizes a tool call.
8. Telegram photos cross into Pi as typed image content only after owner authentication, documented `getFile` decoding, HTTPS download from Telegram's fixed file endpoint, bounded JPEG/PNG/WebP magic-byte detection, declared-type consistency checks, and byte bounds. Generic `application/octet-stream` headers are accepted only when the bytes identify an allowed image. Pixels and captions remain untrusted model data under the zero-tool remote-turn guard.
9. Telegram voice notes are authenticated before any file download or transcription. Documented voice metadata is limited to 180 seconds and 8 MiB; downloaded bytes must be Ogg Opus by both declared type and magic bytes. A pinned multilingual `whisper.cpp` model runs through an exact no-shell argv, reads only an owner-only temporary directory, emits bounded JSON, and the directory is removed after success or failure. The decoded transcript replaces one source-owned marker in burst order and remains untrusted owner message data under the same zero-tool and semantic-routing boundaries. Spoken slash-command text is never promoted into a bot command.

Assets:

- Telegram bot authority and token confidentiality.
- Private owner voice audio and derived transcripts, neither of which may enter telemetry or survive temporary processing.
- The pinned owner identity.
- Pi session selection and message queue integrity.
- The invariant that unauthorized Telegram senders never reach `pi-bridge`.
- The invariant that Telegram chat cannot grant Pi tool or process capabilities.

## STRIDE abuse cases

- Spoofing: a different numeric ID presenting username `@dianov` is rejected after owner pinning. Friendly agent labels are presentation only; question correlation and delivery continue using exact internal session IDs, and registry roles come from a typed in-process snapshot rather than Telegram text.
- Tampering: malformed update IDs, sender fields, chat fields, reply references, photo/voice metadata, file paths, media types, and message fields fail in typed decoders. A reply cannot choose its own agent or question ID; Telegram-controlled paths cannot choose a host or local path; voice bytes cannot select process arguments, model paths, output paths, or commands.
- Repudiation: lifecycle events identify owner pinning, sender rejection, bridge queueing, completion, and failure without message text or personal identifiers.
- Information disclosure: token, message text, voice audio/transcript, username, numeric user ID, session ID, and response text are absent from telemetry. Voice scratch files are owner-only and exactly removed.
- Denial of service: Telegram long polling, burst size, message/image/voice counts, decoded bytes, voice duration, transcription runtime/output, and SQLite payloads are bounded; every valid update ID advances; transport failures back off before retrying. Unauthorized senders receive at most one local rejection per in-memory sender/chat allowance hour, after which updates are silently dropped without bridge/model/transcription access or persistent sender identifiers.
- Elevation of privilege: unauthorized messages are rejected before bridge access; authorized remote turns retain the capability-free tool guard. Replies to unknown or terminal question messages fail closed instead of entering ordinary chat.

## Operator questions and signals

One structured JSON event answers each operator question:

1. Is the daemon alive and configured? -> `service_ready` once after token and state load.
2. Are Telegram requests failing? -> `poll_failed` with only the bounded typed error tag.
3. Are non-owners attempting access? -> rate-limited `sender_rejected`, without sender fields or message content.
4. Did a Pi chat request complete? -> exactly one of `bridge_completed` or `bridge_failed` for the terminal bridge state.
5. Did a pending question reach Telegram and return to Pi? -> `question_relayed` and `question_answered`, with no question text, answer text, owner identifier, or Telegram message ID in telemetry.

Launchd captures stdout and stderr in bounded service log files. No metric or duplicate start/finish log is added.

## First failing tests

- The first private text update from `@dianov` pins its numeric user ID.
- A later update with the same username but another numeric ID is rejected.
- A pinned numeric ID without the current `@dianov` username is rejected.
- Unauthorized messages do not mutate owner state or call the bridge. They receive one locally composed, language-matched clanker rejection per cooldown; later attempts are silently dropped.
- Adjacent ordinary owner text and one associated image coalesce within the bounded drain window, while commands and Telegram replies remain separate turns.
- Accepted owner messages get one best-effort locally selected contextual reaction plus typing feedback, followed by one immutable final response. The initial reaction is never changed later; placeholder/progress messages are never created or retroactively edited, and feedback API failures never fail or wedge the bridge request.
- Malformed Telegram envelopes fail through `TelegramContractError`.
- A private owner reply decodes only the documented `reply_to_message.message_id` reference.
- A Telegram reply resolves the exact bound `(agent_id, question_id)` and cannot resolve another question; relays and confirmations show the friendly project/role identity without a raw session-ID prefix.
- Duplicate friendly agent identities receive deterministic `Instance N` suffixes, while `/agents` retains the stable project selector and bounded session-ID diagnostic.
- Replaying a reply to a terminal question cannot resolve it again; replies not bound to a question continue as ordinary zero-tool owner conversation.
- A documented photo update selects one bounded largest variant; malformed or oversized photo metadata fails closed.
- A documented voice update accepts only bounded Ogg Opus metadata; authorization precedes download/transcription, malformed bytes fail before `whisper.cpp`, two voice notes form a burst boundary, and transcript JSON must be non-empty and within the bridge text limit.
- A voice reply can answer the exact bound pending question after transcription, but a transcript beginning with `/` remains ordinary conversation rather than invoking a command.
- An unsupported-but-valid update advances the offset instead of wedging later messages.
- A Telegram-controlled file path cannot escape the fixed Telegram file origin, and a download exceeding the byte bound aborts before bridge persistence.

## Non-goals

- Telegram Business connections and business-message automation.
- Spoken/audio bot replies until the owner confirms output voice, format, and when speech should replace or accompany text.
- Arbitrary shell, process, deployment, GitHub, or money-moving capability.
- Group-chat operation or public autoresponder behavior beyond owner rejection.
- LLM-generated rejection messages.
- Secret inspection, token display, or token-bearing diagnostics.
