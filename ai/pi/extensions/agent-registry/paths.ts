import { isAbsolute, join } from "node:path";

export const registryStateRoot: (xdgStateHome: string | undefined, home: string) => string = (xdgStateHome, home) =>
  join(xdgStateHome && isAbsolute(xdgStateHome) ? xdgStateHome : join(home, ".local", "state"), "pi", "agent-registry");
