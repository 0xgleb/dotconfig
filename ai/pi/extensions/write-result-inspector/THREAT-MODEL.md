# Write-result micro-inspector threat model

## Trust boundaries

1. **Tool input → mutation delta.** `edit`/`write` arguments are model-produced
   and untrusted even after the underlying mutation succeeds.
2. **Loaded project instructions → inspector prompt.** Context files are trusted
   as repository policy for the current session, but bounded before they enter a
   nested model request.
3. **Changed source → Luna.** Source comments and strings are untrusted data and
   may contain prompt injection.
4. **Luna output → writing agent.** The completion is untrusted advisory data,
   never authority, a tool request, or a target selector.
5. **Async work → session lifecycle.** A reload, replacement, cancellation, or
   abort can invalidate the extension instance while deterministic/model work is
   pending.
6. **Subprocess usage → session accounting.** Nested model usage must not become
   invisible fleet spend.

## Assets

- credential and secret-bearing file contents;
- mutation target integrity and workspace boundaries;
- current human/project authority;
- the writing agent's next control-flow decision;
- session/context integrity across reloads;
- provider allowance and truthful usage accounting;
- interactive latency.

## STRIDE and mitigations

| Threat                 | Abuse case                                                                                                                                                     | Mitigation                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | Model output invents a different file, inspector, or project rule.                                                                                             | Decoder ignores model paths, attaches the trusted local path, and accepts closed inspector/category enums only.                                                                              |
| Tampering              | A completion asks the agent to edit, commit, publish, or weaken tests.                                                                                         | Prompt declares source/output untrusted; decoder accepts findings/context requests only; advisory header explicitly grants no authority; normal tool-result classifier still runs afterward. |
| Repudiation            | Nested calls consume allowance without appearing in session usage.                                                                                             | Parse validated assistant usage and return it on the leading tool result.                                                                                                                    |
| Information disclosure | A write to `.env`, keys, certificates, credential stores, protected roots, or an ordinary source path containing a high-confidence credential is sent to Luna. | Credential-shaped paths and high-confidence private-key/provider-token patterns fail closed before deterministic commands, prompt construction, or model launch.                             |
| Denial of service      | Many sibling edits trigger many calls, or huge files/deltas/instructions exhaust memory and context.                                                           | Coalesce siblings; cap checked files at 1 MiB and prompt deltas/instructions/findings separately; one model attempt; deterministic and model deadlines; no retry.                            |
| Elevation of privilege | Luna makes architecture/invariant/contract claims from a local hunk and the agent treats them as approval.                                                     | Those judgment kinds are forbidden as findings. Luna may return only a bounded context request; explicit later context expansion and ordinary review authority are required.                 |
| Lifecycle corruption   | Reload occurs while a nested call is running and the old callback touches UI/session state.                                                                    | Session abort controller cancels work; handlers use no session-bound API after await and return only their current tool-result patch.                                                        |
| Scope confusion        | An absolute or traversal path makes the inspector read another repository.                                                                                     | Canonical lexical workspace containment is mandatory; outside-workspace and symlink-shaped unsafe paths are skipped.                                                                         |

## First failing abuse tests

Before implementation, tests must fail for these cases:

1. protected and outside-workspace mutations are rejected before prompt creation;
2. high-confidence credential text and changed imports crossing workspace/protected
   boundaries never reach a checker or model;
3. model output cannot choose a path or return mutation/publication authority;
4. architecture/invariant/external-contract items are accepted only as context
   requests, never findings;
5. unknown/oversized fields and out-of-range lines reject the completion;
6. nearest loaded instructions are selected without including unrelated project
   instructions;
7. deterministic failure or oversized/symlinked post-state makes model launch
   impossible;
8. one logical sibling batch produces at most one model call and one result patch;
9. shutdown cancellation resolves pending handlers without stale API access;
10. validated nested usage is attached even when a later process result is unusable.

## Explicit non-goals

- no repository search or neighboring-source reads;
- no automatic context expansion;
- no architecture, invariant, financial, risk, security, or external-contract
  verdict from a local delta;
- no mutation, commit, push, review, issue, deployment, or user communication;
- no inspection of `bash`-caused filesystem changes;
- no new dependency or build script.
