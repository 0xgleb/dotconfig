#!/usr/bin/env nu

# Grok worker: the runner behind the job-file pool that the register skill
# documents. It polls one worker's job directory, runs exactly one bounded
# read-only cursor-agent call per job file, and writes the answer into the
# shared results directory under the job file's own name.
#
#   jobs:    ~/code/st0x/.tmp/grok-jobs/<worker>/<name>.md
#   results: ~/code/st0x/.tmp/grok-results/<name>.md        (success)
#            ~/code/st0x/.tmp/grok-results/<name>.md.failed (failure)
#
# Every call is plan mode: the delegate reads and answers, it never edits,
# never runs transitions, never replies on an external channel. Its output is
# advisory input to the calling session's typed actions.
#
# One driver runs per worker name: a second pane for a name already held exits
# instead of racing it. Drop a `stop` file in the worker's job directory to end
# the loop cleanly and release that name.

const JOB_ROOT = "/Users/0xgleb/code/st0x/.tmp/grok-jobs"
const RESULT_ROOT = "/Users/0xgleb/code/st0x/.tmp/grok-results"
const LOCK_ROOT = "/Users/0xgleb/code/st0x/.tmp/grok-locks"

# Poll `worker`'s job directory forever, answering one job per pass.
def main [
  worker: string # worker name, e.g. grok-st0x-1; names its job directory
  --workspace: string = "/Users/0xgleb/code/st0x" # repo root the delegate reads
  --model: string = "grok-4.5-xhigh" # cursor-agent model
  --poll: duration = 10sec # gap between empty passes
] {
  let jobs = ($JOB_ROOT | path join $worker)
  mkdir $jobs
  mkdir $RESULT_ROOT
  mkdir $LOCK_ROOT

  # One driver per worker name, enforced rather than assumed. Independent
  # sessions each spawning "the" pane for a worker is the normal case, and two
  # drivers polling one directory will both claim the same job and write the
  # same result path, losing one answer and billing for both.
  let lock = ($LOCK_ROOT | path join $worker)
  if not (claim-lock $lock $worker) {
    return
  }

  print $"(ansi green)($worker)(ansi reset) watching ($jobs)"
  print $"  workspace ($workspace)  model ($model)  poll ($poll)"

  loop {
    if (($jobs | path join "stop") | path exists) {
      print $"(ansi yellow)($worker) stopping: stop file present(ansi reset)"
      rm -f ($jobs | path join "stop")
      rm -rf $lock
      break
    }

    let pending = (
      glob ($jobs | path join "*.md")
      | sort
    )

    if ($pending | is-empty) {
      sleep $poll
      continue
    }

    answer-one ($pending | first) $workspace $model
  }
}

# Take the worker's exclusive lock, reporting whether this driver may run.
# A lock whose recorded process is gone is reclaimed, so a killed pane never
# wedges its worker permanently.
def claim-lock [lock: string, worker: string]: nothing -> bool {
  if (take-lock $lock) {
    return true
  }

  let holder = (
    try { open ($lock | path join "pid") | str trim | into int } catch { null }
  )
  if $holder != null and (ps | where pid == $holder | is-not-empty) {
    print $"(ansi red)($worker) already has a live driver \(pid ($holder)\) - exiting(ansi reset)"
    return false
  }

  print $"(ansi yellow)($worker) reclaiming lock from dead pid ($holder | default 'unknown')(ansi reset)"
  rm -rf $lock
  take-lock $lock
}

# Create the lock directory, failing when a peer already holds it. The
# external mkdir is deliberate: the builtin creates parents and succeeds on an
# existing directory, so only the external one is a test-and-set.
def take-lock [lock: string]: nothing -> bool {
  if (do { ^mkdir $lock } | complete | get exit_code) != 0 {
    return false
  }
  $nu.pid | into string | save -f ($lock | path join "pid")
  true
}

# Run one job to completion and retire its file either way.
#
# The transport is `stream-json`, not `text`. Under `--output-format text` a
# run that ends without a final assistant text block exits 0 having written
# nothing at all, which reports as a failure carrying no reason. The event
# stream always carries the answer in its terminating `result` event, and
# rendering the events as they arrive is what makes the pane show live
# progress instead of stalling on a silent buffer.
def answer-one [job: string, workspace: string, model: string] {
  let name = ($job | path basename)
  let started = (date now)
  print $"(ansi blue)-> ($name)(ansi reset) ((date now) | format date '%H:%M:%S')"

  let rendered = (
    ^cursor-agent -p --output-format stream-json --stream-partial-output --mode plan --model $model --workspace $workspace (open --raw $job)
    | render-events
  )
  let exit_code = $env.LAST_EXIT_CODE
  let elapsed = ((date now) - $started)

  if $exit_code == 0 and ($rendered.result | str trim | is-not-empty) {
    $rendered.result | save -f ($RESULT_ROOT | path join $name)
    print $"(ansi green)   done ($name) in ($elapsed)(ansi reset)"
  } else {
    # A silent run says nothing about why on its own, so keep whatever the
    # stream did carry: the assistant prose seen so far and any line that
    # failed to parse as an event are the only evidence of the real cause.
    [
      $"exit ($exit_code) after ($elapsed)"
      $"--- assistant text \(($rendered.text | str length) bytes\) ---"
      $rendered.text
      $"--- unparsed stream lines \(($rendered.noise | length)\) ---"
      ($rendered.noise | str join "\n")
    ]
    | str join "\n"
    | save -f ($RESULT_ROOT | path join $"($name).failed")
    print $"(ansi red)   failed ($name): exit ($exit_code), ($rendered.result | str length) bytes result(ansi reset)"
  }

  rm -f $job
}

# Render a cursor-agent event stream to the pane as it arrives, returning the
# terminating result plus the prose and unparsed lines kept for diagnostics.
def render-events []: any -> record<result: string, text: string, noise: list<string>> {
  mut result = ""
  mut text = ""
  mut noise = []

  for line in ($in | lines) {
    let event = (try { $line | from json } catch { null })
    if (($event | describe) | str starts-with "record") == false {
      if ($line | str trim | is-not-empty) {
        $noise = ($noise | append $line)
        print -e $"(ansi dark_gray)($line)(ansi reset)"
      }
      continue
    }

    match ($event.type? | default "") {
      "system" => {
        if ($event.subtype? == "init") {
          print $"(ansi cyan)- init(ansi reset) model=($event.model?)"
        }
      }
      "tool_call" => {
        let tool = (try { $event.tool_call? | columns | first } catch { "tool" })
        print $"(ansi magenta)> ($event.subtype?)(ansi reset) ($tool)"
      }
      "thinking" => {
        if ($event.subtype? == "delta") {
          print -n $"(ansi grey)($event.text?)(ansi reset)"
        }
      }
      "assistant" => {
        let chunk = (
          try { $event.message?.content? | where type == "text" | get 0.text? } catch { "" }
        )
        $text = $text + $chunk
        print -n $"(ansi green)($chunk)(ansi reset)"
      }
      "result" => {
        $result = ($event.result? | default "")
        print $"(ansi cyan)\n  done(ansi reset) ($event.duration_ms?)ms"
      }
      _ => {}
    }
  }

  # A run can stream the whole answer as assistant deltas and still end
  # without a `result` event; the prose is the answer in that case.
  if ($result | str trim | is-empty) {
    $result = $text
  }

  {result: $result, text: $text, noise: $noise}
}
