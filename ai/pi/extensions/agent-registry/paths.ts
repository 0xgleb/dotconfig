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
 * project with no managed role has no designated owner, so a session may pick
 * it up rather than leave its queue stranded - but only for a project it
 * actually contains.
 *
 * Containment rather than equality, because sessions are launched per org and
 * work across the repos inside it: a session in ~/code/st0x serves a request
 * for ~/code/st0x/st0x.issuance, and requiring an exact match would refuse the
 * cross-repo coordination that is the point of running it there. Several
 * sessions sharing one org directory is normal and not a conflict - they hold
 * different roles, and one holder per project and role is what the lease
 * already enforces.
 *
 * The home directory is excluded because it contains every project without
 * being one. A session launched from home would otherwise qualify for every
 * role in the fleet, which is how a dispatcher sitting in home ends up
 * appointed drainer of a path nothing drains.
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
  const contains = cwd === project || project.startsWith(`${cwd}/`);
  return contains && cwd !== home && (!dedicated || cwd === project);
};
