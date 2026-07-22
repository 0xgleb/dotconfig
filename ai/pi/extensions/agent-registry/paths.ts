import { isAbsolute, join } from "node:path";

export const registryStateRoot: (xdgStateHome: string | undefined, home: string) => string = (xdgStateHome, home) =>
  join(xdgStateHome && isAbsolute(xdgStateHome) ? xdgStateHome : join(home, ".local", "state"), "pi", "agent-registry");

export const shouldSelfClaimUnownedRole: (
  project: string,
  role: string,
  cwd: string,
  home: string,
) => boolean = (project, role, cwd, home) => {
  const configProject = join(home, ".config");
  return project !== configProject || role !== "pi-support" || cwd === configProject;
};
