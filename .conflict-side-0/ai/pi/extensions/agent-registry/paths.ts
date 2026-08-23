import { isAbsolute, join } from "node:path"

export const registryStateRoot: (
  xdgStateHome: string | undefined,
  home: string,
) => string = (xdgStateHome, home) =>
  join(
    xdgStateHome && isAbsolute(xdgStateHome)
      ? xdgStateHome
      : join(home, ".local", "state"),
    "pi",
    "agent-registry",
  )

export interface ManagedOperationalRole {
  readonly project: string
  readonly role: string
}

export const managedOperationalRole: (
  cwd: string,
  home: string,
) => ManagedOperationalRole | undefined = (cwd, home) => {
  const roles: ManagedOperationalRole[] = [
    { project: join(home, ".config"), role: "pi-support" },
    { project: join(home, "code", "dataclique", "yielduck"), role: "operator" },
    {
      project: join(home, "code", "dataclique", "moneymentum"),
      role: "operator",
    },
    { project: join(home, "code", "st0x"), role: "reviewer" },
    { project: join(home, "code", "dataclique"), role: "reviewer" },
    { project: join(home, "code", "0xgleb"), role: "reviewer" },
  ]
  return roles.find(({ project }) => project === cwd)
}

export const shouldSelfClaimUnownedRole: (
  project: string,
  role: string,
  cwd: string,
  home: string,
) => boolean = (project, role, cwd, home) => {
  const dedicated = [
    { project: join(home, ".config"), role: "pi-support" },
    { project: join(home, "code", "dataclique", "yielduck"), role: "operator" },
    {
      project: join(home, "code", "dataclique", "moneymentum"),
      role: "operator",
    },
    { project: join(home, "code", "st0x"), role: "reviewer" },
    { project: join(home, "code", "dataclique"), role: "reviewer" },
    { project: join(home, "code", "0xgleb"), role: "reviewer" },
  ].some(candidate => candidate.project === project && candidate.role === role)
  return !dedicated || cwd === project
}
