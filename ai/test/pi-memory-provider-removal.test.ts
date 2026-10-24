import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")

test("managed settings cannot reinstall the removed memory provider", () => {
  for (const path of [
    "ai/pi.settings.json",
    ".auto-resolution/ai/pi.settings.json",
    ".conflict-base-0/ai/pi.settings.json",
    ".conflict-side-0/ai/pi.settings.json",
    ".conflict-side-1/ai/pi.settings.json",
  ]) {
    const settings: unknown = JSON.parse(read(path))
    assert.ok(typeof settings === "object" && settings !== null)
    assert.doesNotMatch(read(path), /pi-hermes-memory|billion-context-pi/)
  }
})

test("memory removal retains the explicitly preserved voice package", () => {
  const settings: unknown = JSON.parse(read("ai/pi.settings.json"))
  assert.ok(
    typeof settings === "object" && settings !== null && "packages" in settings,
  )
  assert.ok(Array.isArray(settings.packages))
  assert.ok(settings.packages.includes("npm:pi-live-codex@0.1.7"))
})

test("snapshot activation sources cannot patch or reinstall the retired provider", () => {
  for (const path of [
    ".auto-resolution/home.nix",
    ".conflict-base-0/home.nix",
    ".conflict-side-0/home.nix",
    ".conflict-side-1/home.nix",
  ])
    assert.doesNotMatch(read(path), /pi-hermes-memory|patchPiHermesMemory/)
})
