import assert from "node:assert/strict"
import test from "node:test"
import {
  pieceOfPiStatePath,
  remoteBridgeDatabasePath,
  remoteBridgeStateRoot,
} from "./paths.ts"

test("bridge state uses XDG state home when configured", () => {
  assert.equal(
    remoteBridgeStateRoot("/state", "/home/me"),
    "/state/pi/remote-control",
  )
  assert.equal(
    remoteBridgeDatabasePath("/state", "/home/me"),
    "/state/pi/remote-control/bridge.sqlite",
  )
})

test("bridge state falls back below the user local state directory", () => {
  assert.equal(
    remoteBridgeDatabasePath(undefined, "/home/me"),
    "/home/me/.local/state/pi/remote-control/bridge.sqlite",
  )
})

test("the extension and the Telegram daemon resolve one owner state path", () => {
  assert.equal(
    pieceOfPiStatePath("/state", "/home/me"),
    "/state/pi/piece-of-pi-telegram.json",
  )
  assert.equal(
    pieceOfPiStatePath(undefined, "/home/me"),
    "/home/me/.local/state/pi/piece-of-pi-telegram.json",
  )
})
