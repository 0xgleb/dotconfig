import { isAbsolute, join } from "node:path";

export const registryStateRoot: (xdgStateHome: string | undefined, home: string) => string = (xdgStateHome, home) =>
  join(xdgStateHome && isAbsolute(xdgStateHome) ? xdgStateHome : join(home, ".local", "state"), "pi", "agent-registry");

export interface ManagedOperationalRole {
  readonly project: string;
  readonly role: string;
}

const managedRoles: (home: string) => readonly ManagedOperationalRole[] = (home) => [
  { project: join(home, ".config"), role: "pi-support" },
  { project: join(home, "code", "dataclique", "yielduck"), role: "operator" },
  { project: join(home, "code", "st0x"), role: "reviewer" },
  { project: join(home, "code", "dataclique"), role: "reviewer" },
  { project: join(home, "code", "0xgleb"), role: "reviewer" },
];

/**
 * The standing role a session sitting in this directory holds, if any. A
 * managed role is taken only by the session in its own project: it designates
 * the one session that drains that project's queue, so it is never inferred
 * from a directory that merely contains the project.
 *
 * Taking any other unowned role is an explicit act - `agent_registry
 * action=claim` - rather than something delegating a request does on a
 * session's behalf. A queued request with no owner waits for the session that
 * claims the role instead of appointing a drainer that never runs it.
 */
export const managedOperationalRole: (cwd: string, home: string) => ManagedOperationalRole | undefined = (
  cwd,
  home,
) => managedRoles(home).find(({ project }) => project === cwd);
