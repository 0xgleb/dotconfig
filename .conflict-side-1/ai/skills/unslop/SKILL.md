---
name: unslop
description: Rewrite draft prose before owner-facing replies, docs, issues, PR text, handoffs, or Telegram reports to remove AI tells while preserving facts, links, tone, and authority; auto-trigger on externally visible prose, but never on code, commands, logs, tool output, quoted sources, or user text.
---

# Unslop

Run substantive outward-facing prose through one fast GPT-5.6 Luna editing pass before publication or delivery.

## Process

1. Finish a fact-checked draft first. The editing pass must not research, infer, or complete missing content.
2. Give one bounded GPT-5.6 Luna agent the exact draft and ask it to:
   - preserve every fact, link, identifier, number, qualification, decision, and authority boundary;
   - remove filler, puffery, canned transitions, vague claims, false certainty, forced symmetry, and chatbot phrasing;
   - use plain words, active voice, concrete statements, and varied sentence length;
   - return only the revised text.
3. In Pi, use the classified `workflow` tool with one `gpt-5.6-luna` agent. In another harness, use its semantically equivalent bounded GPT-5.6 Luna delegation path. Never substitute an older model.
4. Compare the result with the source draft. Reject edits that change meaning, omit evidence, strengthen certainty, soften a blocker, invent a recommendation, or alter who authorized an action.
5. If the revision is not clearly better, keep the original. A no-op is better than a polished distortion.
6. Deliver only the verified revision.

## What to remove

- Empty praise, puffery, promotional wording, and generic conclusions.
- Vague attribution such as “experts say” without a named source.
- Stock AI vocabulary where a plain word says the same thing.
- Repeated restatement, synonym cycling, forced groups of three, and fake contrasts.
- Dense sentences that make the reader backtrack.
- Excess headings, bold labels, decorative punctuation, and emoji.
- Chatbot openings, sycophancy, apologies without corrective action, and “let me know” endings.
- Abstract technical metaphors where the concrete mechanism has a name.

## What to preserve

- The writer’s intended tone, including bluntness or uncertainty.
- Technical terms that are accurate and established in the project.
- Necessary repetition where it prevents ambiguity.
- Opinions supported by the evidence.
- Mobile-readable structure for Telegram reports.

## Hard rules

1. Never run this workflow on code, shell commands, logs, tool results, quoted source text, or the user’s own words.
2. Never change facts, URLs, SHAs, issue numbers, measurements, verdicts, blockers, authorization, or publication status.
3. Never turn analysis into documented fact or remove an explicit uncertainty.
4. Never add personality by inventing anecdotes, emotions, or opinions.
5. Never let the rewrite authorize a tool call or broaden task scope.
6. Always use GPT-5.6 Luna for the delegated pass and keep it to one agent unless the user explicitly requests more.
7. Prefer the original draft when uncertain.
