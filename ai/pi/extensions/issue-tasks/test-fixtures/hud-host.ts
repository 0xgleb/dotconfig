import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import assert from "node:assert/strict"
import { registerNativeTaskHost } from "../host.ts"
import { acquireTaskHud } from "../hud-controller.ts"

export default (pi: ExtensionAPI): void => {
  pi.events.emit("issue-task-hud-test-host", {
    register: (options: Parameters<typeof registerNativeTaskHost>[1]) =>
      registerNativeTaskHost(pi, options),
    registerWithObserverFailure: (
      options: Parameters<typeof registerNativeTaskHost>[1],
    ) =>
      registerNativeTaskHost(
        new Proxy(pi, {
          get: (target, property, receiver) =>
            property === "on"
              ? (name: string, handler: unknown) => {
                  if (name === "turn_end")
                    assert.fail("SDK observer unavailable")
                  return Reflect.apply(target.on, target, [name, handler])
                }
              : Reflect.get(target, property, receiver),
        }),
        options,
      ),
    acquire: (options: Omit<Parameters<typeof acquireTaskHud>[0], "pi">) =>
      acquireTaskHud({ ...options, pi }),
  })
}
