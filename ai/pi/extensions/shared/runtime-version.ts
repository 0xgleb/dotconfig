import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MANAGED_CONFIG_GENERATION = "2026.07.23.103";
export const RUNTIME_VERSION_REQUEST_EVENT = "pi:runtime-version-request";

export const piHostRuntimeVersions = (entrypoint: string | undefined): Readonly<Record<string, string>> => {
  const hostVersion = entrypoint?.match(/pi-coding-agent-([0-9.]+)/)?.[1] ?? "unknown";
  const hostBuild = entrypoint?.match(/\/nix\/store\/([a-z0-9]+)-pi-coding-agent-/)?.[1] ?? "unknown";
  return { "pi-host": hostVersion, "pi-host-build": hostBuild };
};
export type RuntimeVersionReporter = (component: string, version: string) => void;

export const registerRuntimeVersion = (pi: ExtensionAPI, component: string, version: string): void => {
  pi.events.on(RUNTIME_VERSION_REQUEST_EVENT, (report: RuntimeVersionReporter) => report(component, version));
};
