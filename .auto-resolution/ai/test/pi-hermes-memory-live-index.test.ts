import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const patch = readFileSync(
  new URL(
    "../pi/patches/pi-hermes-memory-bounded-live-index.patch",
    import.meta.url,
  ),
  "utf8",
)
const backfillPatch = readFileSync(
  new URL(
    "../pi/patches/pi-hermes-memory-bounded-session-backfill.patch",
    import.meta.url,
  ),
  "utf8",
)
const home = readFileSync(new URL("../../home.nix", import.meta.url), "utf8")
const settings = readFileSync(
  new URL("../pi.settings.json", import.meta.url),
  "utf8",
)

test("live Hermes indexing uses a bounded in-memory tail instead of the growing JSONL", () => {
  assert.match(settings, /npm:pi-hermes-memory@0\.8\.1/)
  assert.match(patch, /MAX_LIVE_SESSION_ENTRIES = 512/)
  assert.match(patch, /\.slice\(-MAX_LIVE_SESSION_ENTRIES\)/)
  assert.match(patch, /return indexCurrentSession\(dbManager, sessionManager\)/)
  assert.doesNotMatch(
    patch.split("function indexLiveSessionOnce").at(-1) ?? "",
    /^\+.*parseSessionFile/m,
  )
})

test("startup backfill reads a bounded head and tail for oversized sessions", () => {
  assert.match(backfillPatch, /MAX_SESSION_HEADER_READ_BYTES = 64 \* 1024/)
  assert.match(
    backfillPatch,
    /MAX_SESSION_TAIL_READ_BYTES = 16 \* 1024 \* 1024/,
  )
  assert.match(backfillPatch, /fs\.readSync\(fd, header/)
  assert.match(backfillPatch, /fs\.readSync\(fd, tail/)
  assert.match(
    backfillPatch,
    /const content = readBoundedSessionText\(filePath\)/,
  )
  assert.doesNotMatch(
    backfillPatch,
    /^\+\s*const content = fs\.readFileSync\(filePath/m,
  )
})

test("Home Manager applies both patches only to the reviewed package version", () => {
  assert.match(home, /patchPiHermesMemory = lib\.hm\.dag\.entryAfter/)
  assert.match(home, /package_version.*!= "0\.8\.1"/s)
  assert.match(home, /MAX_LIVE_SESSION_ENTRIES/)
  assert.match(home, /MAX_SESSION_TAIL_READ_BYTES/)
  assert.match(home, /pi-hermes-memory-bounded-session-backfill\.patch/)
  assert.match(home, /patch --batch --forward/)
})
