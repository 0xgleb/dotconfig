# 09. Telegram topics are the routing key

- Status: Proposed
- Date: 2026-08-04
- Issue: None (personal orchestration architecture); builds on ADR 03 (the Pi
  message bridge) and ADR 02 (the agent registry)

## Context

Every lane shares one Telegram channel. All of their reports, questions,
notices, and replies land in a single timeline, and there is no way to hold a
conversation with one agent without the others' traffic interleaving through
it.

The same flatness is a correctness problem, not only a reading problem. A
message going the other way carries nothing that says which lane it is for, so
the dispatcher infers the target from prose. That inference is where the
routing defects come from: work filed against the wrong project, messages
delivered to a lane that was not the addressee, and items landing in a queue
nothing drains.

Telegram supergroups support forum topics, and a message posted in a topic
carries a `message_thread_id`. That identifier is a routing key chosen by the
sender at send time, which is better evidence than anything a model can infer
from the text.

## Decision

**One topic per agent, and the topic is the routing key.**

- **Inbound routing stops being inferred.** A message arriving with a
  `message_thread_id` goes to the lane bound to that topic. No classification,
  no roster guessing, no fallback to whichever project the dispatcher happens
  to sit in. Model-based routing survives only where there is no topic: direct
  messages and the group's general thread.
- **Bindings are explicit and persisted**, mapping a topic id to a lane. A
  message in an unbound topic is answered saying it is unbound, rather than
  routed on a guess. Binding is an operator action; an agent never infers one.
- **A lane answers in the topic it was addressed in.** A reply, a question
  card, and a lane's own reports go to that lane's topic, so hopping between
  topics is how the reader moves between agents.
- **Bot identity is orthogonal and stays as it is.** The group already holds
  more than one bot, and each keeps posting exactly as it does today. Routing
  keys off the topic, not off which account posts, so this decision neither
  needs nor forces a change to how many bots there are or which one speaks.

Topic ids are assigned by Telegram per chat, so bindings are environment state,
not repository configuration.

## Deliberately not in this decision

Each of these is wanted, and each is a separate change that should be reviewed
on its own terms rather than smuggled in beside the routing key:

- **Binding agents to distinct bot identities**, so a lane speaks as a
  particular bot rather than through whichever account the orchestrator uses.
  Several bots already share the group; what is deferred is making that
  correspondence meaningful.
- **Report topics with in-place revision**, where a report holds a stable
  identity and a correction edits the existing message instead of appending a
  new one below the stale version.
- **A second human role.** Authorization stays exactly as it is: one owner,
  everyone else refused.
- **An isolated host**, which changes the trust boundary rather than the
  routing.

## Consequences

- The largest class of routing bug disappears by construction: a message posted
  in a topic cannot be misrouted, because nothing is inferring anything. That
  matters more than the reading experience that motivated the change.
- New operational surface is one binding table and the thread id threaded
  through send and receive. A missing binding degrades to "unbound, say so",
  which fails visibly instead of misdelivering quietly.
- Direct messages keep working unchanged, so anything that should not sit in a
  group thread still has a home.
- Nothing here forecloses the deferred items: per-bot identities, report
  topics, and a role model each layer onto a topic-addressed chat without
  revisiting this decision.
