import type { Terminal } from "@earendil-works/pi-tui"

export type NativeViewId = "worker" | "manager"

export type NativeViewActivation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "invalid_view" | "terminal_failure" }

export interface NativeViewTerminals {
  readonly worker: Terminal
  readonly manager: Terminal
  readonly activate: (view: unknown) => NativeViewActivation
  readonly active: () => NativeViewId
}

export const createNativeViewTerminals = (
  physical: Terminal,
): NativeViewTerminals => {
  let active: NativeViewId = "worker"
  let activation = Symbol()
  const listeners = new Map<NativeViewId, Parameters<Terminal["start"]>>()
  const start = (
    view: NativeViewId,
    callbacks: Parameters<Terminal["start"]>,
    token: symbol,
  ): void => {
    const [onInput, onResize] = callbacks
    physical.start(
      data => {
        if (active === view && activation === token) onInput(data)
      },
      () => {
        if (active === view && activation === token) onResize()
      },
    )
  }

  const scoped = (view: NativeViewId): Terminal => {
    const owned = (effect: () => void): void => {
      if (active === view) effect()
    }
    return {
      start: (onInput, onResize) => {
        const callbacks: Parameters<Terminal["start"]> = [onInput, onResize]
        listeners.set(view, callbacks)
        owned(() => {
          activation = Symbol()
          start(view, callbacks, activation)
        })
      },
      stop: () => {
        listeners.delete(view)
        owned(() => {
          physical.stop()
          activation = Symbol()
        })
      },
      drainInput: (maxMs, idleMs) =>
        active === view
          ? physical.drainInput(maxMs, idleMs)
          : Promise.resolve(),
      write: data => owned(() => physical.write(data)),
      get columns() {
        return physical.columns
      },
      get rows() {
        return physical.rows
      },
      get kittyProtocolActive() {
        return physical.kittyProtocolActive
      },
      moveBy: lines => owned(() => physical.moveBy(lines)),
      hideCursor: () => owned(() => physical.hideCursor()),
      showCursor: () => owned(() => physical.showCursor()),
      clearLine: () => owned(() => physical.clearLine()),
      clearFromCursor: () => owned(() => physical.clearFromCursor()),
      clearScreen: () => owned(() => physical.clearScreen()),
      setTitle: title => owned(() => physical.setTitle(title)),
      setProgress: running => owned(() => physical.setProgress(running)),
      setProgramStatus: status =>
        owned(() => physical.setProgramStatus(status)),
    }
  }

  return {
    worker: scoped("worker"),
    manager: scoped("manager"),
    active: () => active,
    activate: view => {
      if (view !== "worker" && view !== "manager")
        return { ok: false, code: "invalid_view" }
      if (view === active) return { ok: true }
      const next = Symbol()
      const callbacks = listeners.get(view)
      try {
        physical.stop()
        if (callbacks) start(view, callbacks, next)
      } catch {
        return { ok: false, code: "terminal_failure" }
      }
      activation = next
      active = view
      if (callbacks) callbacks[1]()
      return { ok: true }
    },
  }
}
