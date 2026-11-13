import {
  getSelectListTheme,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent"
import {
  Container,
  Editor,
  ScrollView,
  Text,
  VStack,
  matchesKey,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui"
import { Effect, Either } from "effect"
import { ManagerError, type ManagerTurn } from "./manager-core.ts"

export interface ManagerChatOptions {
  readonly turns: readonly ManagerTurn[]
  readonly initialQuestion?: string
  readonly notice?: string
  readonly signal: AbortSignal
  readonly submit: (
    question: string,
    signal: AbortSignal,
  ) => Promise<Either.Either<string, ManagerError>>
  readonly close: () => void
}

export type ManagerChatView = (
  ctx: ExtensionContext,
  options: Omit<ManagerChatOptions, "close">,
) => Promise<void>

export class ManagerChatPanel extends VStack implements Focusable {
  private readonly tui: TUI
  private readonly theme: Theme
  private readonly options: ManagerChatOptions
  private readonly transcript = new Container()
  private readonly status = new Text("", 1, 0)
  private readonly header: Text
  private readonly footer = new Text(
    "Enter send · PgUp/PgDn history · Esc close",
    1,
    0,
  )
  private readonly composer: Editor
  private readonly scroll: ScrollView
  private active: AbortController | undefined
  private closed = false

  constructor(tui: TUI, theme: Theme, options: ManagerChatOptions) {
    super()
    this.tui = tui
    this.theme = theme
    this.options = options
    this.header = new Text(theme.bold("Manager"), 1, 0)
    this.composer = new Editor(tui, {
      borderColor: text => theme.fg("border", text),
      selectList: getSelectListTheme(),
    })
    this.scroll = new ScrollView(this.transcript, {
      follow: "end",
      scrollbar: "auto",
      overscroll: "contain",
    })

    this.addChild(this.header)
    this.addChild(this.scroll, { grow: 1 })
    this.addChild(this.status)
    this.addChild(this.composer, { maxSize: 8 })
    this.addChild(this.footer)

    for (const turn of options.turns) {
      this.append("You", turn.question)
      this.append("Manager", turn.answer)
    }

    if (options.notice) this.append("Manager", options.notice)

    this.composer.onSubmit = text => {
      void this.send(text)
    }
    options.signal.addEventListener("abort", this.close, { once: true })

    if (options.signal.aborted) this.close()
    else if (options.initialQuestion) void this.send(options.initialQuestion)
  }

  get focused(): boolean {
    return this.composer.focused
  }

  set focused(value: boolean) {
    this.composer.focused = value
  }

  render(width: number): string[] {
    const height = Math.max(1, Math.floor(this.tui.terminal.rows * 0.85))
    const composerRows = Math.min(8, this.composer.render(width).length)
    const fixedRows =
      this.header.render(width).length +
      this.status.render(width).length +
      composerRows +
      this.footer.render(width).length
    const contentRows = this.transcript.render(
      this.scroll.getContentWidth(width),
    ).length

    this.scroll.updateLayout(contentRows, Math.max(0, height - fixedRows), () =>
      this.tui.requestRender(),
    )

    return super.render(width)
  }

  handleInput(data: string): void {
    if (this.closed) return

    if (matchesKey(data, "escape")) {
      this.close()
      return
    }

    if (matchesKey(data, "pageup") || matchesKey(data, "pagedown")) {
      this.scroll.scrollBy(matchesKey(data, "pageup") ? -8 : 8)
      this.tui.requestRender()
      return
    }

    if (this.active && matchesKey(data, "enter")) return
    this.composer.handleInput(data)
  }

  dispose(): void {
    this.close()
  }

  private append(role: string, text: string): void {
    const following = this.scroll.isFollowingEnd
    this.transcript.addChild(
      new Text(`${this.theme.bold(role)}\n${text}`, 1, 1),
    )
    if (following) this.scroll.scrollToEnd()
  }

  private readonly close = (): void => {
    if (this.closed) return

    this.closed = true
    this.active?.abort()
    this.options.signal.removeEventListener("abort", this.close)
    this.options.close()
  }

  private async send(question: string): Promise<void> {
    if (this.closed || this.active || !question.trim()) return

    if (
      question.length > 4000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(question)
    ) {
      this.status.setText(
        "Question must fit 4,000 characters and contain no terminal controls.",
      )
      this.tui.requestRender()
      return
    }

    const controller = new AbortController()
    this.active = controller
    this.composer.disableSubmit = true
    this.composer.addToHistory(question)
    this.composer.setText("")
    this.append("You", question)
    this.status.setText("Manager is replying…")
    this.tui.requestRender()

    const requested = await Effect.runPromise(
      Effect.either(
        Effect.tryPromise({
          try: () => this.options.submit(question, controller.signal),
          catch: () =>
            new ManagerError({
              code: "model_failed",
              message: "Manager request failed.",
            }),
        }),
      ),
    )

    if (this.closed || controller.signal.aborted) return

    const reply = Either.flatMap(requested, result => result)
    this.active = undefined
    this.composer.disableSubmit = false
    this.status.setText("")

    if (Either.isLeft(reply)) this.append("Manager", reply.left.message)
    else this.append("Manager", reply.right)

    this.tui.requestRender()
  }
}

export const openManagerChat: ManagerChatView = (ctx, options) =>
  ctx.ui.custom<void>(
    (tui, theme, _keys, done) =>
      new ManagerChatPanel(tui, theme, { ...options, close: done }),
    {
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" },
    },
  )
