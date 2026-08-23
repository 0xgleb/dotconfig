import { join } from "node:path"

const userStateRoot = (
  xdgStateHome: string | undefined,
  home: string,
): string => xdgStateHome?.trim() || join(home, ".local", "state")

export const remoteBridgeStateRoot = (
  xdgStateHome: string | undefined,
  home: string,
): string => join(userStateRoot(xdgStateHome, home), "pi", "remote-control")

export const remoteBridgeDatabasePath = (
  xdgStateHome: string | undefined,
  home: string,
): string => join(remoteBridgeStateRoot(xdgStateHome, home), "bridge.sqlite")

/**
 * The Piece of Pi daemon and the remote-control extension run as separate
 * processes and share the owner chat only through this file, so the path must
 * be derived here rather than spelled out at either end.
 */
export const pieceOfPiStatePath = (
  xdgStateHome: string | undefined,
  home: string,
): string =>
  join(userStateRoot(xdgStateHome, home), "pi", "piece-of-pi-telegram.json")
