# Blocks publishing private agent-bus communication to public surfaces.
#
# Everything on the bus (Telegram relays, bridge messages, registry requests)
# is private working communication. This guard denies a publishing command
# whose payload carries the fingerprints of pasted comms - speaker attribution,
# transport names, message ids, or the unguarded register people use when
# talking to a tool. It fires on the command text the agent is about to run,
# so the block lands before anything reaches GitHub.
#
# Deliberately narrow: it matches attribution and transport markers, NOT
# subject matter. An issue that discusses `pi-bridge` internals or the
# `owner-telegram.ts` renderer is legitimate technical writing and passes;
# one that says who asked for it, or quotes them, does not.

const PUBLISHING = [
    'gh issue create'
    'gh issue edit'
    'gh issue comment'
    'gh pr create'
    'gh pr edit'
    'gh pr comment'
    'gh pr review'
    'gh release create'
    'gh gist create'
    'git commit'
    'git tag'
]

# Attribution and transport fingerprints. Each is a phrase that only appears
# when a message is being reproduced or credited, never when the same fact is
# restated technically.
const MARKERS = [
    'via telegram'
    'telegram-dispatch'
    'owner request'
    'owner directive'
    'owner impact'
    'owner asked'
    'owner said'
    'owner wants'
    'owner complained'
    'the owner is'
    'owner message'
    'per the owner'
    'quoting the owner'
    # Protocol frame names are deliberately absent. `relay-to-owner` is an
    # identifier in the source, so an issue analysing that frame is ordinary
    # technical writing; matching it blocked a bug report ABOUT the frame.
    # Pasted relay content betrays itself through the attribution and register
    # markers above, which is where the signal actually lives.
    #
    # Citing a specific message by id is reproduction, but naming the
    # subsystem is not: `registry request <uuid>` is a leak, while "registry
    # requests expire after an hour" is the technical prose we want.
    'registry request [0-9a-f]{8}'
    'bridge message [0-9a-f]{8}'
    'dedupe key [0-9a-f]{8}'
    'request [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}'
]

# Unguarded register: profanity in a payload is near-conclusive evidence of
# pasted conversation rather than authored technical prose.
const REGISTER = ['fuck' 'shit' 'bitch' 'bullshit' 'goddamn']

def deny [reason: string] {
    {
        hookSpecificOutput: {
            hookEventName: "PreToolUse"
            permissionDecision: "deny"
            permissionDecisionReason: $reason
        }
    }
    | to json -r
}

def main [] {
    let payload = ^cat | from json
    if ($payload.tool_name? | default "") != "Bash" { return }

    let command = ($payload.tool_input?.command? | default "")
    if ($command | is-empty) { return }

    let lowered = ($command | str lowercase)
    let publishing = ($PUBLISHING | any {|verb| $lowered =~ $verb })
    if not $publishing { return }

    let hits = ($MARKERS | where {|marker| $lowered =~ $marker })
    let register_hits = ($REGISTER | where {|word| $lowered =~ $word })
    let all_hits = ($hits | append $register_hits)
    if ($all_hits | is-empty) { return }

    deny $"Private comms guard: this publishing command carries fingerprints of private agent-bus communication -- ($all_hits | str join ', '). Bus traffic is private working communication and never becomes a public artifact: no verbatim text, no block quotes, no speaker attribution, no transport or message ids. Publish the substance instead - state the technical fact in your own neutral words and cite the code or behaviour rather than the conversation. See Private Comms Never Become Public Artifacts in AGENTS.md, rewrite the payload, and run it again."
}
