import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const editorSource = readFileSync(
  new URL("../vim-editor.ts", import.meta.url),
  "utf8",
)
const extensionSource = readFileSync(
  new URL("../index.ts", import.meta.url),
  "utf8",
)

test("queued follow-ups have one host-owned projection and never reappear inside the editor", () => {
  assert.doesNotMatch(
    editorSource,
    /pendingSubmissions|renderPendingSubmissionLines|PENDING/,
  )
  assert.doesNotMatch(extensionSource, /clearPendingSubmission/)
})

test("the prompt inherits Pi's bounded scrolling viewport without post-render queue injection", () => {
  const render = editorSource.slice(
    editorSource.indexOf("override render(width: number)"),
  )
  assert.match(render, /const lines = super\.render\(contentWidth\)/)
  assert.doesNotMatch(
    render,
    /lines\.splice\(\s*1,\s*0,[\s\S]*pending|pending[\s\S]*lines\.splice/,
  )
})

test("follow-up text is submitted once to Pi's canonical queue", () => {
  const followUpBranch = editorSource.slice(
    editorSource.indexOf('submissionMode === "followUp"'),
    editorSource.indexOf('submissionMode === "steer"'),
  )
  assert.match(followUpBranch, /this\.onFollowUp\(submittedText\)/)
  assert.doesNotMatch(followUpBranch, /pending|queue/)
})
