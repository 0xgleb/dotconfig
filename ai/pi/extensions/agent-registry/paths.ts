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

export const managedOperationalRole: (cwd: string, home: string) => ManagedOperationalRole | undefined = (
  cwd,
  home,
) => managedRoles(home).find(({ project }) => project === cwd);

/**
 * A managed role is taken only by the session sitting in its project. A
 * project with no managed role has no designated owner, so any session may
 * pick it up rather than leave its queue stranded.
 */
export const shouldSelfClaimUnownedRole: (
  project: string,
  role: string,
  cwd: string,
  home: string,
) => boolean = (project, role, cwd, home) => {
  const dedicated = managedRoles(home).some(
    (candidate) => candidate.project === project && candidate.role === role,
  );
  return !dedicated || cwd === project;
};
