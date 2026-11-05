---
name: unslop
description: Rewrite draft prose before owner-facing replies, docs, issues, PR text, handoffs, or Telegram reports to remove AI tells while preserving facts, links, tone, and authority; auto-trigger on externally visible prose, but never on code, commands, logs, tool output, quoted sources, or user text.
---

# Unslop

Run substantive outward-facing prose through one bounded editing pass using an
available GPT model from generation 6 or later before publication or delivery.

## Process

1. Finish a fact-checked draft first. The editing pass must not research, infer,
   or complete missing content.
2. Give one bounded GPT generation 6 or later agent the exact draft and ask it
   to:
   - preserve every fact, link, identifier, number, qualification, decision, and
     authority boundary;
   - remove filler, puffery, canned transitions, vague claims, false certainty,
     forced symmetry, and chatbot phrasing;
   - use plain words, active voice, concrete statements, and varied sentence
     length;
   - apply the writing checks below and fix each clear defect without changing
     meaning;
   - return only the revised text.
3. Choose an available GPT model from generation 6 or later, preferring a fast
   variant suitable for editing. In Pi, use the classified `workflow` tool with
   that model. In another harness, use its semantically equivalent bounded
   delegation path. Verify the model is available; never use any GPT-5.x model,
   including GPT-5.6, or an older generation.
4. Compare the result with the source draft. Reject edits that change meaning,
   omit evidence, strengthen certainty, soften a blocker, invent a
   recommendation, or alter who authorized an action.
5. If the revision is not clearly better, keep the original. A no-op is better
   than a polished distortion.
6. Deliver only the verified revision.

## Writing checks and fixes

Apply these alongside the removal checks below. Fix clear defects rather than
merely listing them. They are checks, not blanket bans: passive voice,
repetition and longer sentences can clarify a technical contract.

- **Tautology and empty definitions:** replace circular definitions and empty
  name echoes with the responsibility, behavior, input or output they should
  explain. Keep informative statements even when the noun and verb share a root.
- **Redundant wording:** remove padding such as “in order to,” “each individual”
  and “currently existing” when the shorter form preserves meaning.
- **Repeated rules:** give each rule one authoritative home. Elsewhere,
  reference it or explain its consequence; retain repetition that prevents
  ambiguity.
- **Unclear actors:** name who acts when ownership matters.
- **Weak verbs:** replace unnecessary nominalizations with direct verbs, such as
  “reconciles balances” instead of “performs the reconciliation of balances.”
- **Overloaded sentences:** separate a rule, its exception and its rationale
  when combining them makes the reader backtrack. Preserve the exception’s
  scope.
- **Vague references:** clarify “this,” “it,” “the above” and similar references
  when the intended referent is established but unclear in the wording.
- **Terminology drift:** use one term per concept and preserve defined
  distinctions. Do not merge concepts or rename established identifiers to
  create superficial consistency.
- **Imprecise qualifiers:** scrutinize “normally,” “sufficient,” “promptly” and
  “where necessary.” Use an established condition or policy when available; do
  not invent thresholds or resolve an open decision through copy editing.
- **Meta commentary:** remove drafting history, agreement markers,
  self-evaluation and announcements of what the document explains. Preserve
  labels that distinguish requirements, proposals and deferred work.
- **Buried requirements:** distinguish requirements, options, examples and
  deferred capabilities. If an example contains an established requirement
  absent from the main text, state it there without expanding its authority.
- **Unhelpful examples:** keep examples that resolve ambiguity or expose a
  consequence. Shorten or remove those that merely paraphrase a rule, respecting
  any explicit requirement to retain illustrations.
- **Nonparallel lists:** align comparable items in conceptual level and
  grammatical structure without forcing unlike concepts into a false symmetry.
- **Unnecessary abstraction:** name concrete operations and relationships
  instead of vague phrases such as “facilitates the orchestration of
  interactions.”

When a repair would require missing facts or a technical decision, preserve the
meaning and identify the ambiguity separately; do not silently redesign the
content.

## What to remove

- Empty praise, puffery, promotional wording, and generic conclusions.
- Vague attribution such as “experts say” without a named source.
- Stock AI vocabulary where a plain word says the same thing.
- Repeated restatement, synonym cycling, forced groups of three, and fake
  contrasts.
- Dense sentences that make the reader backtrack.
- Excess headings, bold labels, decorative punctuation, and emoji.
- Chatbot openings, sycophancy, apologies without corrective action, and “let me
  know” endings.
- Abstract technical metaphors where the concrete mechanism has a name.

## What to preserve

- The writer’s intended tone, including bluntness or uncertainty.
- Technical terms that are accurate and established in the project.
- Necessary repetition where it prevents ambiguity.
- Opinions supported by the evidence.
- Mobile-readable structure for Telegram reports.

## Hard rules

1. Never run this workflow on code, shell commands, logs, tool results, quoted
   source text, or the user’s own words.
2. Never change facts, URLs, SHAs, issue numbers, measurements, verdicts,
   blockers, authorization, or publication status.
3. Never turn analysis into documented fact or remove an explicit uncertainty.
4. Never add personality by inventing anecdotes, emotions, or opinions.
5. Never let the rewrite authorize a tool call or broaden task scope.
6. Use only GPT generation 6 or later for the delegated pass and keep it to one
   agent unless the user explicitly requests more. Never fall back to GPT-5.x or
   older models.
7. Prefer the original draft when uncertain.
