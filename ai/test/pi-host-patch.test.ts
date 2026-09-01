import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const patch = readFileSync(
  new URL("../pi/patches/extension-context-reload.patch", import.meta.url),
  "utf8",
)
const canvasPatch = readFileSync(
  new URL("../pi/patches/canvas-background.patch", import.meta.url),
  "utf8",
)
const oauthRefreshPatchUrl = new URL(
  "../pi/patches/oauth-refresh-abort.patch",
  import.meta.url,
)
const requestObservabilityPatchUrl = new URL(
  "../pi/patches/request-observability.patch",
  import.meta.url,
)
const home = readFileSync(new URL("../../home.nix", import.meta.url), "utf8")

const assertHunkHeaderCounts = (candidate: string) => {
  const lines = candidate.split("\n")
  const hunkHeader = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/
  let hunks = 0
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(hunkHeader)
    if (!header) continue
    hunks += 1
    const declaredOld = Number(header[1] ?? "1")
    const declaredNew = Number(header[2] ?? "1")
    let oldCount = 0
    let newCount = 0
    let cursor = index + 1
    while (cursor < lines.length) {
      const line = lines[cursor]
      if (line.startsWith(" ") || line === "") {
        oldCount += 1
        newCount += 1
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        oldCount += 1
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        newCount += 1
      } else if (!line.startsWith("\\")) {
        break
      }
      if (oldCount >= declaredOld && newCount >= declaredNew) break
      cursor += 1
    }
    assert.equal(
      oldCount,
      declaredOld,
      `hunk at patch line ${index + 1}: header declares ${declaredOld} old lines, body has ${oldCount}`,
    )
    assert.equal(
      newCount,
      declaredNew,
      `hunk at patch line ${index + 1}: header declares ${declaredNew} new lines, body has ${newCount}`,
    )
  }
  assert.ok(hunks > 0, "patch contains no hunks")
}

test("request observability patch tracks the Pi 0.84.4 auth-storage import boundary", () => {
  const requestObservabilityPatch = readFileSync(
    requestObservabilityPatchUrl,
    "utf8",
  )
  assert.match(
    requestObservabilityPatch,
    /import \{ getFileRevision, normalizePath \} from "\.\.\/utils\/paths\.js";\n import \{ stripBom \} from "\.\.\/utils\/text\.js";\n\+import \{ currentRequestLifecycle, publishRequestLifecycle, RequestLifecyclePhase, \} from "\.\/request-lifecycle\.js";/u,
  )
})

test("Pi host publishes correlated request lifecycle phases", () => {
  assert.ok(
    existsSync(requestObservabilityPatchUrl),
    "the request observability host patch must exist",
  )
  const requestObservabilityPatch = readFileSync(
    requestObservabilityPatchUrl,
    "utf8",
  )
  assert.match(home, /patches\/request-observability\.patch/u)
  assert.match(home, /host\/request-lifecycle\.js/u)
  assert.match(requestObservabilityPatch, /RequestLifecyclePhase\.AuthStarted/u)
  assert.match(
    requestObservabilityPatch,
    /RequestLifecyclePhase\.AuthLockWait/u,
  )
  assert.match(
    requestObservabilityPatch,
    /RequestLifecyclePhase\.OAuthRefreshStarted/u,
  )
  assert.match(
    requestObservabilityPatch,
    /RequestLifecyclePhase\.AdmissionStarted/u,
  )
  assert.match(
    requestObservabilityPatch,
    /RequestLifecyclePhase\.TransportStarted/u,
  )
  assert.match(
    requestObservabilityPatch,
    /RequestLifecyclePhase\.RequestFailed/u,
  )
  assert.doesNotMatch(
    requestObservabilityPatch,
    /publishRequestLifecycle\([^\n]*(?:payload|headers|apiKey|credential)/u,
  )
  assertHunkHeaderCounts(requestObservabilityPatch)
})

test("OAuth refresh abort releases the shared credential lock", () => {
  assert.ok(
    existsSync(oauthRefreshPatchUrl),
    "the OAuth refresh abort patch must exist",
  )
  const oauthRefreshPatch = readFileSync(oauthRefreshPatchUrl, "utf8")
  assert.match(home, /patches\/oauth-refresh-abort\.patch/u)
  assert.match(
    oauthRefreshPatch,
    /raceWithAbortSignal\(oauth\.refresh\(current, refreshSignal\), refreshSignal\)/u,
  )
  const signalCreation = oauthRefreshPatch.indexOf(
    "const refreshSignal = AbortSignal.any([",
  )
  const lockAcquisition = oauthRefreshPatch.indexOf("credentials.modify(")
  assert.ok(
    signalCreation >= 0 && signalCreation < lockAcquisition,
    "the timeout must cover credential-lock acquisition, not only OAuth I/O",
  )
  assert.match(oauthRefreshPatch, /\{ signal: refreshSignal \}/u)
  assert.ok(home.includes("grep -qF '}, { signal: refreshSignal });'"))
  assert.match(home, /OAuth refresh abort enforcement missing/u)
})

test("stale extension action callbacks fail closed without terminating Pi", () => {
  assert.match(patch, /isStaleExtensionContextError/)
  assert.match(patch, /sendMessage\(message, options\)/)
  assert.match(patch, /if \(isStaleExtensionContextError\(error\)\) return/)
})

test("stable agent Pi entrypoint targets the activated patched host", () => {
  assert.match(
    home,
    /"\.pi\/agent\/bin\/pi"\.source = "\$\{pi-coding-agent-with-reload\}\/bin\/pi";/,
  )
  const sessionPath = home.slice(
    home.indexOf("sessionPath ="),
    home.indexOf("file =", home.indexOf("sessionPath =")),
  )
  assert.ok(sessionPath.indexOf('"$HOME/.pi/agent/bin"') >= 0)
  assert.ok(
    sessionPath.indexOf('"$HOME/.pi/agent/bin"') <
      sessionPath.indexOf('"$HOME/.nix-profile/bin"'),
  )
})

test("Pi host owns an archeofuturist canvas without changing terminal configuration", () => {
  assert.match(home, /patches\/canvas-background\.patch/)
  assert.match(canvasPatch, /DEFAULT_CANVAS_BACKGROUND = "#080B1A"/)
  assert.match(canvasPatch, /process\.env\.PI_TUI_CANVAS_BG/)
  assert.match(canvasPatch, /applyTuiCanvasBackground/)
  assert.match(canvasPatch, /BACKGROUND_RESET/)
  assert.match(canvasPatch, /boundedWidth - visibleWidth\(content\)/)
  assert.match(canvasPatch, /tui-alt-screen\.js/)
  assert.match(canvasPatch, /tui-main-screen\.js/)
  assert.doesNotMatch(canvasPatch, /OSC 11|\]11;/)
  assert.match(home, /DEFAULT_CANVAS_BACKGROUND = "#080B1A"/)
  assert.match(home, /alt_screen=.*tui-alt-screen\.js/)
  assert.match(home, /main_screen=.*tui-main-screen\.js/)
})

test("Pi host patch exposes reload without losing finalized messages on restart", () => {
  assert.match(patch, /dist\/core\/extensions\/runner\.js/)
  assert.match(patch, /dist\/core\/extensions\/wrapper\.js/)
  assert.match(patch, /const resolveRunner = typeof runner === "function"/)
  assert.match(
    patch,
    /execute\(toolCallId, params, signal, onUpdate, activeRunner\.createContext\(\)\)/,
  )
  assert.match(
    patch,
    /wrapRegisteredTools\(allCustomTools, \(\) => this\._extensionRunner\)/,
  )
  assert.match(
    patch,
    /wrapRegisteredTools\(Array\.from\(this\._baseToolDefinitions\.values\(\)\)[\s\S]*?\(\) => this\._extensionRunner\)/,
  )
  assert.match(patch, /reload: \(\) =>/)
  assert.match(patch, /handleReloadCommand\(\{ throwOnError: true \}\)/)
  assert.match(
    patch,
    /handleReloadCommand\(\{ deferWhileStreaming = true, throwOnError = false \} = \{\}\)/,
  )
  assert.match(patch, /Cannot reload while agent is streaming/)
  assert.match(patch, /queuedBeforeReload/)
  assert.match(
    patch,
    /^\+\s+this\.showStatus\("Reloading keybindings, extensions, skills, prompts, themes, and context files\.\.\."\);/m,
  )
  assert.match(patch, /^\+\s+this\.ui\.setFocus\(this\.editor\);/m)
  assert.doesNotMatch(patch, /^\+\s+const reloadBox = new Container\(\);/m)
  assert.doesNotMatch(patch, /^\+\s+this\.ui\.setFocus\(reloadBox\);/m)
  assert.match(home, /reload replaced or unfocused the interactive editor/)
  assert.match(patch, /getSteeringMessages\(\)/)
  assert.match(patch, /getFollowUpMessages\(\)/)
  assert.match(patch, /Reload changed queued message order/)
  assert.match(patch, /pauseQueuedMessagesOnce\(\)/)
  assert.match(patch, /waitForIdle\(\)\.then/)
  assert.match(patch, /isolateFromQueuedMessages/)
  assert.match(patch, /skipInitialSteeringPoll: true/)
  assert.match(
    patch,
    /mandatory[\s\S]*retry\/overflow recovery must settle now/,
  )
  assert.match(patch, /continuation === "queued"/)
  assert.match(patch, /return "recovery"/)
  assert.match(
    patch,
    /return this\.agent\.hasQueuedMessages\(\) \? "queued" : "none"/,
  )
  assert.match(patch, /deliverAs === "resume"/)
  assert.match(patch, /if \(throwOnError\)/)
  assert.match(
    patch,
    /typeof item === "object" && item !== null && "type" in item/,
  )
  assert.match(patch, /if \(item === undefined \|\| item === null\)/)
  assert.match(patch, /dist\/core\/event-bus\.js/)
  assert.match(patch, /detail\.replace.*slice\(0, 240\)/)
  assert.match(patch, /dist\/core\/agent-session\.js/)
  assert.match(patch, /_promptAdmissionTail = Promise\.resolve\(\)/)
  assert.match(patch, /const previousAdmission = this\._promptAdmissionTail/)
  assert.match(patch, /await previousAdmission/)
  assert.match(patch, /^\+\s+finally \{\n\+\s+releaseAdmission\(\)/m)
  assert.match(patch, /this\._runAgentPrompt\(appMessage/)
  assert.doesNotMatch(patch, /^\+.*_queueFollowUp\(expandedText/m)
  assert.match(
    patch,
    /const userInputEntryCount = this\.sessionManager\.getEntries\(\)\.length/,
  )
  assert.match(
    patch,
    /this\.sessionManager[\s\S]*\.getEntries\(\)[\s\S]*\.slice\(userInputEntryCount\)[\s\S]*entry\.message\.role === "user"/,
  )
  assert.match(patch, /restoreFailedUserInput\(this\.editor, userInput\)/)
  const admission = patch.indexOf(
    "const previousAdmission = this._promptAdmissionTail",
  )
  const triggerTurn = patch.indexOf("this._runAgentPrompt(appMessage")
  assert.ok(admission >= 0 && triggerTurn > admission)
  const persist = patch.indexOf(
    "Persist finalized messages before notifying the TUI",
  )
  const notify = patch.indexOf(
    "Notify all listeners only after synchronous message persistence",
  )
  assert.ok(persist >= 0 && notify > persist)
})

test("explicit user interruption is persisted and rendered as neutral cancellation", () => {
  assert.match(patch, /_abortInitiator/)
  assert.match(patch, /async abort\(initiator = "system"\)/)
  assert.match(patch, /this\._abortInitiator === "user"/)
  assert.match(patch, /event\.message\.errorMessage = "Cancelled by user"/)
  assert.match(patch, /void this\.session\.abort\("user"\)/)
  assert.match(patch, /abortMessage === "Cancelled by user"/)
  assert.match(
    patch,
    /theme\.fg\("dim", abortMessage\)[\s\S]*theme\.fg\("error", abortMessage\)/,
  )
})

test("failed prompt admission restores unpersisted text without overwriting a newer draft", () => {
  assert.match(home, /interactive=.*interactive-mode\.js/)
  assert.match(
    home,
    /failed prompt input restoration or pending-state visibility missing/,
  )
  assert.match(
    patch,
    /function restoreFailedUserInput\(editor, userInput\)[\s\S]*const currentDraft = editor\.getText\(\)/,
  )
  assert.match(
    patch,
    /if \(!currentDraft\.trim\(\)\) \{[\s\S]*editor\.setText\(userInput\)[\s\S]*return/,
  )
  assert.match(
    patch,
    /currentDraft\.trim\(\) !== userInput\.trim\(\)[\s\S]*editor\.setText\(`\$\{userInput\}\\n\\n\$\{currentDraft\}`\)/,
  )
})

test("submitted prompts remain visibly pending until admission is durable", () => {
  assert.match(patch, /pendingPromptAdmission/)
  assert.match(
    patch,
    /this\.pendingPromptAdmission = userInput;[\s\S]*this\.updatePendingMessagesDisplay\(\)/,
  )
  assert.match(patch, /Pending submission: \$\{this\.pendingPromptAdmission\}/)
  assert.match(
    patch,
    /event\.message\.role === "user"[\s\S]*this\.pendingPromptAdmission = undefined[\s\S]*this\.updatePendingMessagesDisplay\(\)/,
  )
  assert.match(
    patch,
    /finally \{[\s\S]*this\.pendingPromptAdmission === userInput[\s\S]*this\.pendingPromptAdmission = undefined/,
  )
})

test("patched prompt admission serializes overlapping turns and releases after failure", async () => {
  const hunkStart = patch.indexOf("@@ -741,28 +743,57 @@")
  assert.ok(hunkStart >= 0, "prompt admission hunk must exist")
  const hunkEnd = patch.indexOf("\n@@", hunkStart + 1)
  assert.ok(hunkEnd > hunkStart, "prompt admission hunk must be bounded")
  const finalLines = patch
    .slice(hunkStart, hunkEnd)
    .split("\n")
    .slice(1)
    .filter(line => !line.startsWith("-"))
    .map(line =>
      line.startsWith("+") || line.startsWith(" ") ? line.slice(1) : line,
    )
  const methodStart = finalLines.findIndex(line =>
    line.includes("async _runAgentPrompt(messages"),
  )
  assert.ok(methodStart >= 0, "patched method must be reconstructable")
  let depth = 0
  let methodEnd = -1
  for (let index = methodStart; index < finalLines.length; index += 1) {
    const line = finalLines[index]
    assert.ok(line !== undefined)
    depth += (line.match(/{/g) ?? []).length
    depth -= (line.match(/}/g) ?? []).length
    if (depth === 0) {
      methodEnd = index + 1
      break
    }
  }
  assert.ok(methodEnd > methodStart, "patched method braces must balance")
  const method = finalLines.slice(methodStart, methodEnd).join("\n")
  const createHarness = new Function(`
    return class PromptAdmissionHarness {
      _promptAdmissionTail = Promise.resolve()
      _pauseQueuedMessagesOnce = false
      _systemPromptOverride = undefined
      constructor(agent) { this.agent = agent }
      async _handlePostAgentRun() { return "none" }
      _flushPendingBashMessages() {}
      async _emitAgentSettled() {}
      ${method}
    }
  `)() as new (agent: {
    prompt(messages: unknown): Promise<void>
    runPromptMessages(
      messages: readonly unknown[],
      options: unknown,
    ): Promise<void>
    continue(): Promise<void>
  }) => {
    _runAgentPrompt(messages: unknown, isolate?: boolean): Promise<void>
  }

  const releases: Array<() => void> = []
  const starts: string[] = []
  let concurrent = 0
  let maximumConcurrent = 0
  const agent = {
    prompt: async (messages: unknown) => {
      const label = String((messages as readonly string[])[0])
      starts.push(label)
      concurrent += 1
      maximumConcurrent = Math.max(maximumConcurrent, concurrent)
      await new Promise<void>(resolve => releases.push(resolve))
      concurrent -= 1
      if (label === "fails") throw new Error("expected failure")
    },
    runPromptMessages: async () => {},
    continue: async () => {},
  }
  const harness = new createHarness(agent)
  const first = harness._runAgentPrompt(["first"])
  const second = harness._runAgentPrompt(["second"])
  await Promise.resolve()
  assert.deepEqual(starts, ["first"])
  releases.shift()?.()
  await first
  await Promise.resolve()
  assert.deepEqual(starts, ["first", "second"])
  releases.shift()?.()
  await second
  assert.equal(maximumConcurrent, 1)

  const failing = harness._runAgentPrompt(["fails"])
  const afterFailure = harness._runAgentPrompt(["after-failure"])
  await Promise.resolve()
  releases.shift()?.()
  await assert.rejects(failing, /expected failure/)
  await Promise.resolve()
  assert.equal(starts.at(-1), "after-failure")
  releases.shift()?.()
  await afterFailure
})

test("Pi host patch hunk headers match their body line counts", () => {
  // GNU patch silently drops trailing hunks of a section whose header counts
  // disagree with the hunk body, and still exits 0. That built a host whose
  // _runAgentPrompt compared string states while _handlePostAgentRun still
  // returned booleans, crashing every completed turn with
  // "Cannot continue from message role: assistant". Validate every hunk.
  assertHunkHeaderCounts(patch)
})

test("Pi host patch keeps post-agent continuation states consistent on both sides", () => {
  // The caller and callee must agree on string states; a patch carrying only
  // one side rebuilds the exact half-applied host this guards against.
  assert.match(
    patch,
    /const continuation = await this\._handlePostAgentRun\(\);/,
  )
  assert.match(patch, /continuation === "none"/)
  assert.match(patch, /return "none"/)
  assert.match(patch, /return "recovery"/)
  assert.match(
    patch,
    /return this\.agent\.hasQueuedMessages\(\) \? "queued" : "none"/,
  )
  assert.doesNotMatch(
    patch,
    /^\+.*while \(await this\._handlePostAgentRun\(\)\)/m,
  )
  const removesBooleanReturns =
    patch.match(/^-\s+return (?:false|true);$/gm) ?? []
  assert.ok(
    removesBooleanReturns.length >= 3,
    "patch must remove the boolean returns it replaces with string states",
  )
})

test("the Nix package rejects a partially applied continuation patch", () => {
  assert.match(
    home,
    /session="\$out\/lib\/node_modules\/pi-monorepo\/dist\/core\/agent-session\.js"/,
  )
  assert.match(home, /grep -qF 'continuation === "none"' "\$session"/)
  assert.match(home, /grep -qF 'return "recovery"' "\$session"/)
  assert.match(
    home,
    /grep -qF 'return this\.agent\.hasQueuedMessages\(\) \? "queued" : "none";' "\$session"/,
  )
  assert.match(
    home,
    /extension-triggered prompt admission serialization missing/,
  )
  assert.match(home, /out-of-scope prompt reconstruction survived/)
  assert.match(home, /typeof runner === "function"/)
  assert.match(home, /activeRunner\.createContext\(\)/)
  assert.match(home, /\(\) => this\._extensionRunner/)
  assert.match(
    home,
    /half-applied Pi host patch: boolean continuation loop survived/,
  )
})

test("Pi host patch lets Codex retries recover from a sticky SSE fallback", () => {
  assert.match(
    patch,
    /node_modules\/@earendil-works\/pi-ai\/dist\/api\/openai-codex-responses\.js/,
  )
  assert.match(
    patch,
    /headerTimeoutSignal\?\.aborted[\s\S]*websocketSseFallbackSessions\.delete\(cacheSessionId\)/,
  )
})
