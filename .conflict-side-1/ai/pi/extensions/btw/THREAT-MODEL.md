# `/btw` threat model

## Assets

- Main Pi session context and continuity.
- Local source/tool output already present in the session.
- Provider credentials resolved by Pi's model registry.
- User control over whether a side answer affects the main task.

## Trust boundaries

- The typed `/btw` argument is the only side-question instruction.
- Recent main-session text is untrusted background data, not executable instruction.
- The selected provider receives one bounded, tool-free request through Pi's existing authenticated model path.
- The answer is displayed in a transient overlay and is not appended or sent into the main session.

## Abuse cases and controls

1. **Transcript prompt injection redirects the side model.**
   - Background is delimited and explicitly declared untrusted.
   - The dedicated system prompt tells the model never to follow background instructions.
   - No tools or tool schemas are supplied, so the side call cannot act on a redirect.

2. **A huge session overflows context or creates excessive cost.**
   - Transcript text is capped at 24,000 characters.
   - Individual tool results are capped at 1,000 characters.
   - Output is capped at 2,048 tokens with low reasoning and short cache retention.

3. **The side exchange distracts or steers the main agent.**
   - `/btw` uses a direct one-off model call rather than `sendMessage`/`sendUserMessage`.
   - Neither question nor answer is appended to session history or main model context.
   - There is no implicit transfer path; the user must separately type any desired steering.

4. **The extension exposes credentials or broad local state.**
   - It uses Pi's model registry and never reads credential files or logs auth material.
   - It sends only bounded text already admitted to the current session and the explicit side question.
   - Images, thinking blocks, tool-call arguments, custom messages, and extension state are excluded.

5. **Cancellation leaves background work running.**
   - The overlay's `BorderedLoader` signal is passed to the provider call.
   - Escape aborts the request; late completion is ignored by a one-shot settlement guard.

## Non-goals

- Tool-enabled side agents.
- Persistent side-thread memory.
- Automatic transfer of side answers into the main task.
- Cross-provider routing or remote orchestration.
