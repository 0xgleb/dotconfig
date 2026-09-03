import { Container, type Component, type TUI } from "@earendil-works/pi-tui"

const FOCUSED_INPUT_CACHE = "__piVimFocusedInputRenderCache20260823" as const

type MutableComponent = Component & {
  render(width: number): string[]
  handleInput?(data: string): void
}

interface PatchableTui extends TUI {
  children: MutableComponent[]
  focusedComponent: MutableComponent | null
  hasOverlayEntries: boolean
  previousLines: string[]
  previousWidth: number
  applyLineResets(lines: string[]): string[]
  doRender(): void
  requestRender(force?: boolean): void
  [FOCUSED_INPUT_CACHE]?: true
}

type InputLatencyCacheStatus =
  | "eligible"
  | "external-render"
  | "generation-changed"
  | "overlay"
  | "root-missing"

export interface FocusedInputLatencySample {
  readonly recordedAt: number
  readonly inputEvents: number
  readonly inputBytes: number
  readonly cacheStatus: InputLatencyCacheStatus
  readonly inputHandlerMs: number
  readonly queueDelayMs: number
  readonly renderMs: number
  readonly rootRenderMs: number
  readonly focusedRootRenderMs: number
  readonly siblingRootRenderMs: number
  readonly lineResetMs: number
  readonly lineResetLines: number
  readonly terminalWriteMs: number
  readonly terminalWriteCalls: number
  readonly terminalBytes: number
  readonly residualRenderMs: number
  readonly inputToWriteMs: number
  readonly totalMs: number
  readonly previousFrameLines: number
  readonly renderedLines: number
}

export interface FocusedInputLatencySnapshot {
  readonly samples: readonly FocusedInputLatencySample[]
}

const MAX_INPUT_LATENCY_SAMPLES = 64
let inputLatencySamples: FocusedInputLatencySample[] = []

export const getFocusedInputLatencySnapshot =
  (): FocusedInputLatencySnapshot => ({
    samples: inputLatencySamples.map(sample => ({ ...sample })),
  })

export const resetFocusedInputLatencySnapshot = (): void => {
  inputLatencySamples = []
}

const recordInputLatencySample = (sample: FocusedInputLatencySample): void => {
  inputLatencySamples = [...inputLatencySamples, sample].slice(
    -MAX_INPUT_LATENCY_SAMPLES,
  )
}

interface PendingInputFrame {
  readonly startedAt: number
  readonly handlerEndedAt: number
  readonly inputEvents: number
  readonly inputBytes: number
  readonly inputHandlerMs: number
  readonly cacheStatus: InputLatencyCacheStatus
}

interface ActiveRenderFrame {
  rootRenderMs: number
  focusedRootRenderMs: number
  siblingRootRenderMs: number
  lineResetMs: number
  lineResetLines: number
  terminalWriteMs: number
  terminalWriteCalls: number
  terminalBytes: number
  lastWriteAt: number | undefined
}

const containsComponent = (root: Component, target: Component): boolean => {
  if (root === target) return true
  if (!(root instanceof Container)) return false
  return root.children.some(child => containsComponent(child, target))
}

const patchableTui = (tui: TUI): PatchableTui | undefined => {
  const candidate = tui as unknown as Partial<PatchableTui>
  return Array.isArray(candidate.children) &&
    Array.isArray(candidate.previousLines) &&
    typeof candidate.applyLineResets === "function" &&
    typeof candidate.doRender === "function" &&
    typeof candidate.requestRender === "function"
    ? (candidate as PatchableTui)
    : undefined
}

/**
 * Compatibility shim for already-running Pi 0.84.2 hosts.
 *
 * A regular-mode host rebuilds every transcript component on every keypress.
 * This shim caches top-level sibling roots only for the exact frame initiated
 * by the focused editor. Any non-editor render request invalidates that proof,
 * and the next frame renders every root normally. Future hosts carry the same
 * invariant in pi-tui itself; the shim then detects that host path and is inert.
 */
export const installFocusedInputRenderCache = (
  tui: TUI,
  editor: MutableComponent,
): (() => void) => {
  const host = patchableTui(tui)
  if (!host || host[FOCUSED_INPUT_CACHE]) return () => {}
  const nativeFocusedInputCache =
    typeof (host as unknown as { consumeFocusedInputRenderTarget?: unknown })
      .consumeFocusedInputRenderTarget === "function"
  if (nativeFocusedInputCache) return () => {}

  const roots = [...host.children]
  const originalRootRenders = new Map(
    roots.map(root => [root, root.render.bind(root)] as const),
  )
  const rendered = new Map<
    MutableComponent,
    { readonly width: number; readonly lines: string[] }
  >()
  const originalApplyLineResets = host.applyLineResets.bind(host)
  const originalDoRender = host.doRender.bind(host)
  const originalRequestRender = host.requestRender.bind(host)
  const terminal = host.terminal as TUI["terminal"] & {
    write(data: string): void
  }
  const originalTerminalWrite = terminal.write.bind(terminal)
  const originalEditorInput = editor.handleInput?.bind(editor)
  if (!originalEditorInput) return () => {}

  let disposed = false
  let handlingEditorInput = false
  let externalRenderRequested = true
  let renderMutationGeneration = 0
  let focusedRoot: MutableComponent | undefined
  let pendingInput: PendingInputFrame | undefined
  let activeRender: ActiveRenderFrame | undefined
  let decoratedWidth = 0
  const decorated = new Map<MutableComponent, string[]>()

  for (const root of roots) {
    const originalRender = originalRootRenders.get(root)
    if (!originalRender) continue
    root.render = (width: number): string[] => {
      if (!nativeFocusedInputCache && focusedRoot && root !== focusedRoot) {
        const cached = rendered.get(root)
        if (cached?.width === width) return cached.lines
      }
      const started = activeRender ? performance.now() : 0
      const lines = originalRender(width)
      if (activeRender) {
        const elapsed = performance.now() - started
        activeRender.rootRenderMs += elapsed
        if (root === focusedRoot) activeRender.focusedRootRenderMs += elapsed
        else activeRender.siblingRootRenderMs += elapsed
      }
      rendered.set(root, { width, lines })
      return lines
    }
  }

  host.applyLineResets = (lines: string[]): string[] => {
    const started = activeRender ? performance.now() : 0
    try {
      if (nativeFocusedInputCache) return originalApplyLineResets(lines)
      if (
        !focusedRoot ||
        host.hasOverlayEntries ||
        decoratedWidth !== host.terminal.columns
      )
        return originalApplyLineResets(lines)

      let offset = 0
      const prepared: string[] = []
      const needsCanvas: boolean[] = []
      for (const root of roots) {
        const raw = rendered.get(root)?.lines
        const cached = decorated.get(root)
        if (!raw || (root !== focusedRoot && cached?.length !== raw.length))
          return originalApplyLineResets(lines)
        const nextOffset = offset + raw.length
        if (nextOffset > lines.length) return originalApplyLineResets(lines)
        if (root === focusedRoot) {
          const normalized = originalApplyLineResets(
            lines.slice(offset, nextOffset),
          )
          for (const line of normalized) {
            prepared.push(line)
            needsCanvas.push(true)
          }
        } else {
          for (const line of cached ?? []) {
            prepared.push(line)
            needsCanvas.push(false)
          }
        }
        offset = nextOffset
      }
      if (offset !== lines.length) return originalApplyLineResets(lines)

      Object.defineProperty(prepared, "map", {
        configurable: true,
        value: <T>(
          callback: (value: string, index: number, array: string[]) => T,
        ): Array<string | T> =>
          Array.from(prepared, (line, index) =>
            needsCanvas[index] ? callback(line, index, prepared) : line,
          ),
      })
      return prepared
    } finally {
      if (activeRender) {
        activeRender.lineResetMs += performance.now() - started
        activeRender.lineResetLines += lines.length
      }
    }
  }

  terminal.write = (data: string): void => {
    const started = activeRender ? performance.now() : 0
    try {
      originalTerminalWrite(data)
    } finally {
      if (activeRender) {
        activeRender.terminalWriteMs += performance.now() - started
        activeRender.terminalWriteCalls += 1
        activeRender.terminalBytes += Buffer.byteLength(data)
        activeRender.lastWriteAt = performance.now()
      }
    }
  }

  host.requestRender = (force = false): void => {
    if (!handlingEditorInput) {
      focusedRoot = undefined
      externalRenderRequested = true
      renderMutationGeneration += 1
    }
    originalRequestRender(force)
  }

  host.doRender = (): void => {
    const input = pendingInput
    pendingInput = undefined
    const renderStarted = performance.now()
    const previousFrameLines = host.previousLines.length
    const frame: ActiveRenderFrame | undefined = input
      ? {
          rootRenderMs: 0,
          focusedRootRenderMs: 0,
          siblingRootRenderMs: 0,
          lineResetMs: 0,
          lineResetLines: 0,
          terminalWriteMs: 0,
          terminalWriteCalls: 0,
          terminalBytes: 0,
          lastWriteAt: undefined,
        }
      : undefined
    activeRender = frame
    try {
      originalDoRender()
      if (!nativeFocusedInputCache && !host.hasOverlayEntries) {
        let offset = 0
        const nextDecorated = new Map<MutableComponent, string[]>()
        for (const root of roots) {
          const length = rendered.get(root)?.lines.length
          if (
            length === undefined ||
            offset + length > host.previousLines.length
          )
            break
          nextDecorated.set(
            root,
            host.previousLines.slice(offset, offset + length),
          )
          offset += length
        }
        if (
          offset === host.previousLines.length &&
          nextDecorated.size === roots.length
        ) {
          decorated.clear()
          for (const [root, lines] of nextDecorated) decorated.set(root, lines)
          decoratedWidth = host.previousWidth
        }
      }
    } finally {
      const ended = performance.now()
      if (input && frame) {
        const renderMs = ended - renderStarted
        recordInputLatencySample({
          recordedAt: Date.now(),
          inputEvents: input.inputEvents,
          inputBytes: input.inputBytes,
          cacheStatus: input.cacheStatus,
          inputHandlerMs: input.inputHandlerMs,
          queueDelayMs: Math.max(0, renderStarted - input.handlerEndedAt),
          renderMs,
          rootRenderMs: frame.rootRenderMs,
          focusedRootRenderMs: frame.focusedRootRenderMs,
          siblingRootRenderMs: frame.siblingRootRenderMs,
          lineResetMs: frame.lineResetMs,
          lineResetLines: frame.lineResetLines,
          terminalWriteMs: frame.terminalWriteMs,
          terminalWriteCalls: frame.terminalWriteCalls,
          terminalBytes: frame.terminalBytes,
          residualRenderMs: Math.max(
            0,
            renderMs -
              frame.rootRenderMs -
              frame.lineResetMs -
              frame.terminalWriteMs,
          ),
          inputToWriteMs: Math.max(
            0,
            (frame.lastWriteAt ?? ended) - input.startedAt,
          ),
          totalMs: Math.max(0, ended - input.startedAt),
          previousFrameLines,
          renderedLines: host.previousLines.length,
        })
      }
      activeRender = undefined
      focusedRoot = undefined
      externalRenderRequested = false
    }
  }

  editor.handleInput = (data: string): void => {
    const started = performance.now()
    const generationAtInput = renderMutationGeneration
    const hadExternalRender = externalRenderRequested
    handlingEditorInput = true
    try {
      originalEditorInput(data)
      const candidate = roots.find(root => containsComponent(root, editor))
      const cacheStatus: InputLatencyCacheStatus = host.hasOverlayEntries
        ? "overlay"
        : hadExternalRender
          ? "external-render"
          : renderMutationGeneration !== generationAtInput
            ? "generation-changed"
            : candidate
              ? "eligible"
              : "root-missing"
      focusedRoot = cacheStatus === "eligible" ? candidate : undefined
      const ended = performance.now()
      pendingInput = {
        startedAt: pendingInput?.startedAt ?? started,
        handlerEndedAt: ended,
        inputEvents: (pendingInput?.inputEvents ?? 0) + 1,
        inputBytes:
          (pendingInput?.inputBytes ?? 0) + Buffer.byteLength(data, "utf8"),
        inputHandlerMs: (pendingInput?.inputHandlerMs ?? 0) + (ended - started),
        cacheStatus,
      }
    } finally {
      handlingEditorInput = false
    }
  }

  host[FOCUSED_INPUT_CACHE] = true

  return () => {
    if (disposed) return
    disposed = true
    editor.handleInput = originalEditorInput
    host.applyLineResets = originalApplyLineResets
    host.requestRender = originalRequestRender
    host.doRender = originalDoRender
    terminal.write = originalTerminalWrite
    for (const [root, render] of originalRootRenders) root.render = render
    rendered.clear()
    decorated.clear()
    delete host[FOCUSED_INPUT_CACHE]
  }
}
