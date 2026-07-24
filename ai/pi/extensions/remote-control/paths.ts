import { join } from "node:path";

export const remoteBridgeStateRoot = (xdgStateHome: string | undefined, home: string): string =>
  join(xdgStateHome?.trim() || join(home, ".local", "state"), "pi", "remote-control");

export const remoteBridgeDatabasePath = (xdgStateHome: string | undefined, home: string): string =>
  join(remoteBridgeStateRoot(xdgStateHome, home), "bridge.sqlite");
