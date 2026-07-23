import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MANAGED_CONFIG_GENERATION = "2026.07.23.16";
export const RUNTIME_VERSION_REQUEST_EVENT = "pi:runtime-version-request";
export type RuntimeVersionReporter = (component: string, version: string) => void;

export const registerRuntimeVersion = (pi: ExtensionAPI, component: string, version: string): void => {
  pi.events.on(RUNTIME_VERSION_REQUEST_EVENT, (report: RuntimeVersionReporter) => report(component, version));
};
