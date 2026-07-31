/**
 * VimEditor - Modal vim editor extending CustomEditor.
 * Routes input to mode-specific handlers and renders mode indicator.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { TUI, EditorOptions, EditorTheme, AutocompleteProvider } from "@earendil-works/pi-tui";
import { createInitialState, modeDisplayName, type VimState } from "./state.ts";
import { promptChromeBottomLine, promptChromeInset, promptChromeTopLine } from "./chrome.ts";
import { moveEditorCursorTo } from "./cursor.ts";
import { displayColumn } from "./display-width.ts";
import { handleNormalMode, type NormalModeContext } from "./modes/normal.ts";
import { handleInsertMode, type InsertModeContext } from "./modes/insert.ts";
import { handleReplaceMode, resetReplaceState, type ReplaceModeContext } from "./modes/replace.ts";
import { handleVisualMode, getVisualRange, type VisualModeContext } from "./modes/visual.ts";
import { DoubleEnterSteering, isSlashCommandInput } from "./steering.ts";
import {
  emptyEditorAttachmentState,
  expandEditorScreenshots,
  redactEditorScreenshot,
  type EditorAttachmentState,
} from "./attachments.ts";
import {
  handleSearchInput,
  getSearchPrompt,
  getSearchState,
  executeSearchMotion,
} from "./search.ts";

export interface VimSteeringOptions {
  readonly isStreaming: () => boolean;
  readonly hasPendingMessages: () => boolean;
  readonly onImmediate: (text: string) => void;
  readonly onQueuedImmediate: () => void;
}

export class VimEditor extends CustomEditor {
  public vimState: VimState;
  private redoStack: Array<{ lines: string[]; cursorLine: number; cursorCol: number }> = [];
  private wrapAutocomplete: ((provider: AutocompleteProvider) => AutocompleteProvider) | undefined;
  private readonly doubleEnterSteering?: DoubleEnterSteering;
  private readonly isStreaming: () => boolean;
  private attachmentState: EditorAttachmentState = emptyEditorAttachmentState();

  /**
   * DECSCUSR cursor styles:
   *   2 => steady block
   *   6 => steady bar (thin)
   */
  private static readonly CURSOR_BLOCK = "\x1b[2 q";
  private static readonly CURSOR_BAR = "\x1b[6 q";

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: any,
    options?: EditorOptions,
    wrapAutocomplete?: (provider: AutocompleteProvider) => AutocompleteProvider,
    steering?: VimSteeringOptions,
  ) {
    super(tui, theme, keybindings, options);
    this.vimState = createInitialState();
    this.wrapAutocomplete = wrapAutocomplete;
    this.isStreaming = steering?.isStreaming ?? (() => false);
    this.doubleEnterSteering = steering
      ? new DoubleEnterSteering({
          windowMs: 350,
          onSubmit: (text) => this.onSubmit?.(text),
          onImmediate: (text) => {
            this.addToHistory(text);
            steering.onImmediate(text);
          },
          hasQueuedMessages: steering.hasPendingMessages,
          onQueuedImmediate: steering.onQueuedImmediate,
        })
      : undefined;
    this.applyCursorShapeForMode(this.vimState.mode);
  }

  /**
   * Apply a hardware cursor shape for the current vim mode.
   * Insert mode uses a thin bar; all other modes use a block.
   */
  private applyCursorShapeForMode(mode: VimState["mode"]): void {
    const isInsert = mode === "insert";
    const seq = isInsert ? VimEditor.CURSOR_BAR : VimEditor.CURSOR_BLOCK;

    // In insert mode we strip the software (reverse-video) cursor in render()
    // and rely on the terminal's hardware cursor to show the bar shape.
    // pi-tui only emits/shows the hardware cursor when this is enabled, so it
    // must be turned on here; otherwise insert mode shows no cursor at all.
    // Other modes keep the software block cursor, so the hardware cursor is
    // disabled to avoid drawing two cursors.
    try {
      this.tui.setShowHardwareCursor(isInsert);
    } catch {
      // Older pi-tui without hardware-cursor toggle; ignore.
    }

    try {
      this.tui.terminal.write(seq);
    } catch {
      // Ignore terminals that don't support DECSCUSR.
    }
  }

  /**
   * Wrap the autocomplete provider with fuzzy file matching for @ queries.
   * This integrates pi-fzfp's weighted dual-key scoring into the vim editor.
   */
  override setAutocompleteProvider(provider: AutocompleteProvider): void {
    super.setAutocompleteProvider(this.wrapAutocomplete ? this.wrapAutocomplete(provider) : provider);
  }

  /**
   * Undo: snapshot current state to redo stack, then perform base editor undo.
   * Works at the same level as the base editor's internal state.
   */
  vimUndo(): void {
    const editor = this as any;
    if (!editor.undoStack || editor.undoStack.length === 0) return;

    // Save current internal state to redo stack before undoing
    const state = editor.state;
    this.redoStack.push(structuredClone(state));

    // Perform base editor undo
    editor.undo();
  }

  /**
   * Redo: restore state from redo stack, push current state to undo stack.
   * Mirrors the base editor's undo mechanism in reverse.
   */
  vimRedo(): void {
    if (this.redoStack.length === 0) return;
    const editor = this as any;
    const snapshot = this.redoStack.pop()!;

    // Push current state to undo stack
    editor.undoStack.push(structuredClone(editor.state));

    // Restore the redo snapshot directly into internal state
    Object.assign(editor.state, snapshot);
    editor.lastAction = null;
    editor.preferredVisualCol = null;
    if (editor.onChange) {
      editor.onChange(this.getText());
    }
  }

  handleInput(data: string): void {
    const isEnter = matchesKey(data, "enter");
    if (isEnter) {
      const expanded = expandEditorScreenshots(this.getText(), this.attachmentState);
      if (expanded !== this.getText()) this.setText(expanded);
      this.attachmentState = emptyEditorAttachmentState();
    }
    const enteringSlashCommand = isEnter && this.vimState.mode === "insert" && isSlashCommandInput(this.getText());
    if (isEnter && this.doubleEnterSteering && !enteringSlashCommand) {
      const result = this.doubleEnterSteering.handleEnter(this.getText(), this.isStreaming());
      if (result === "deferred") this.setText("");
      if (result !== "pass") return;
    }

    const { vimState } = this;
    const modeBefore = vimState.mode;
    const textBefore = this.getText();
    const redoStackBefore = this.redoStack.length;

    switch (vimState.mode) {
      case "insert":
        this.handleInsert(data);
        break;

      case "replace":
        this.handleReplace(data);
        break;

      case "normal":
        this.handleNormal(data);
        break;

      case "visual":
      case "visual-line":
        this.handleVisual(data);
        break;

      case "command-line":
        this.handleCommandLine(data);
        break;

      default:
        // For unimplemented modes, pass through to super
        super.handleInput(data);
        break;
    }

    // Clear redo stack when text changes from a non-undo/redo action.
    // If the redo stack changed size, it was an undo/redo operation — don't clear.
    if (!isEnter && this.getText() !== textBefore) {
      const redacted = redactEditorScreenshot(this.getText(), this.attachmentState);
      if (redacted.text !== this.getText()) this.setText(redacted.text);
      this.attachmentState = redacted.state;
    }
    if (this.getText() === "") this.attachmentState = emptyEditorAttachmentState();

    if (this.redoStack.length === redoStackBefore && this.getText() !== textBefore) {
      this.redoStack.length = 0;
    }

    if (this.vimState.mode !== modeBefore) {
      this.applyCursorShapeForMode(this.vimState.mode);
    }
  }

  private handleInsert(data: string): void {
    const ctx: InsertModeContext = {
      state: this.vimState,
      getCursor: () => this.getCursor(),
      getText: () => this.getText(),
      setText: (text) => this.setText(text),
      moveCursorTo: (line, col) => this.moveCursorTo(line, col),
      superHandleInput: (d) => super.handleInput(d),
    };
    handleInsertMode(data, ctx);
  }

  private handleReplace(data: string): void {
    const ctx: ReplaceModeContext = {
      state: this.vimState,
      getCursor: () => this.getCursor(),
      getText: () => this.getText(),
      setText: (text) => this.setText(text),
      moveCursorTo: (line, col) => this.moveCursorTo(line, col),
      superHandleInput: (d) => super.handleInput(d),
    };
    handleReplaceMode(data, ctx);
  }

  private handleNormal(data: string): void {
    // Escape in normal mode → pass to super (abort agent, etc.)
    if (matchesKey(data, "escape")) {
      super.handleInput(data);
      return;
    }

    const ctx: NormalModeContext = {
      state: this.vimState,
      superHandleInput: (d) => super.handleInput(d),
      getText: () => this.getText(),
      getCursor: () => this.getCursor(),
      setText: (text) => this.setText(text),
      moveCursorTo: (line, col) => this.moveCursorTo(line, col),
      undo: () => this.vimUndo(),
      redo: () => this.vimRedo(),
    };
    handleNormalMode(data, ctx);
  }

  private handleCommandLine(data: string): void {
    const state = getSearchState();
    const returnMode = state.returnMode;
    const result = handleSearchInput(data);

    if (result === "confirm") {
      // Execute the search and move cursor to the match
      const lines = this.getText().split("\n");
      const cursor = this.getCursor();
      const motionResult = executeSearchMotion(lines, cursor);
      this.moveCursorTo(motionResult.position.line, motionResult.position.col);
      this.vimState.mode = returnMode;
    } else if (result === "cancel") {
      this.vimState.mode = "normal";
      this.vimState.visualAnchor = null;
    }
    // "continue" → stay in command-line mode, render will show the prompt
  }

  private handleVisual(data: string): void {
    const ctx: VisualModeContext = {
      state: this.vimState,
      superHandleInput: (d) => super.handleInput(d),
      getText: () => this.getText(),
      getCursor: () => this.getCursor(),
      setText: (text) => this.setText(text),
      moveCursorTo: (line, col) => this.moveCursorTo(line, col),
    };
    handleVisualMode(data, ctx);
  }

  /**
   * Move cursor to an absolute logical position by writing the editor state
   * directly. Arrow-key emulation is wrong here: the base editor moves
   * up/down by *visual* (wrapped) rows, so counting logical lines with arrow
   * presses lands on the wrong line whenever a line wraps (e.g. `G`, `gg`).
   */
  moveCursorTo(targetLine: number, targetCol: number): void {
    moveEditorCursorTo(this as any, targetLine, targetCol);
  }

  /**
   * In insert mode, remove the software reverse-video cursor cell that the base
   * editor draws, so the terminal hardware cursor shape (bar) is visible.
   *
   * The hardware cursor marker remains in place for IME/cursor positioning.
   */
  private stripSoftCursorHighlight(line: string): string {
    const markerIndex = line.indexOf(CURSOR_MARKER);
    if (markerIndex === -1) return line;

    const markerEnd = markerIndex + CURSOR_MARKER.length;
    const before = line.slice(0, markerEnd);
    const after = line.slice(markerEnd);

    // Base editor emits cursor as: \x1b[7m<grapheme>\x1b[0m immediately after marker.
    const strippedAfter = after.replace(/^\x1b\[7m([\s\S]*?)\x1b\[0m/, "$1");
    return before + strippedAfter;
  }

  render(width: number): string[] {
    const inset = promptChromeInset(width);
    const frameWidth = Math.max(12, width - inset * 2);
    const contentWidth = Math.max(1, frameWidth - 2);
    const lines = super.render(contentWidth);
    if (lines.length === 0) return lines;

    // Show only the hardware cursor in insert mode so bar shape is visible.
    if (this.vimState.mode === "insert") {
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        lines[lineIndex] = this.stripSoftCursorHighlight(lines[lineIndex]!);
      }
    }

    // Apply visual selection highlighting if in visual mode
    // Also keep highlighting when in command-line mode initiated from visual
    const isVisual = this.vimState.mode === "visual" || this.vimState.mode === "visual-line";
    const isSearchFromVisual =
      this.vimState.mode === "command-line" &&
      (getSearchState().returnMode === "visual" || getSearchState().returnMode === "visual-line");
    if ((isVisual || isSearchFromVisual) && this.vimState.visualAnchor) {
      this.applyVisualHighlight(lines, contentWidth);
    }

    const last = lines.length - 1;
    lines[0] = this.borderColor(promptChromeTopLine(frameWidth));

    if (this.vimState.mode === "command-line" && getSearchState().active) {
      const prompt = getSearchPrompt();
      lines[last] = this.borderColor(promptChromeBottomLine(frameWidth, `${prompt}█`));
    } else {
      lines[last] = this.borderColor(
        promptChromeBottomLine(frameWidth, `◈ ${modeDisplayName(this.vimState.mode)}`),
      );
    }

    for (let lineIndex = 1; lineIndex < last; lineIndex++) {
      const content = truncateToWidth(lines[lineIndex] ?? "", contentWidth, "");
      const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
      lines[lineIndex] =
        this.borderColor("│") + content + padding + this.borderColor("│");
    }

    const leftMargin = " ".repeat(inset);
    const rightMargin = " ".repeat(Math.max(0, width - inset - frameWidth));
    return lines.map(line => `${leftMargin}${line}${rightMargin}`);
  }

  /**
   * Apply reverse-video highlighting to the visual selection range in rendered output.
   *
   * The rendered output from super.render() is structured as:
   *   [top border, ...content lines (with padding), bottom border, ...autocomplete]
   *
   * Content lines have format: `${leftPadding}${displayText}${rightPadding}`
   * where padding is `paddingX` spaces on each side (default 0).
   * The editor also inserts CURSOR_MARKER (APC sequence) and cursor highlighting.
   *
   * We use pi-tui's extractAnsiCode to properly skip ALL escape sequences
   * (CSI, OSC, APC) when counting visible positions.
   */
  private applyVisualHighlight(renderedLines: string[], width: number): void {
    const text = this.getText();
    const textLines = text.split("\n");
    const cursor = this.getCursor();
    const range = getVisualRange(this.vimState, cursor, textLines);

    // The editor uses paddingX (default 0) for left/right content padding.
    // With paddingX=0: contentWidth = width, layoutWidth = width - 1
    // Content lines start at renderedLines[1] through renderedLines[length-2].
    // The padding property is accessed via getPadding().
    const paddingX = this.getPaddingX();
    const contentWidth = Math.max(1, width - paddingX * 2);
    const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));

    // Map text line index → first rendered line index (1-based, after top border)
    const textLineToRenderedStart: number[] = [];
    let renderedIdx = 1; // skip top border
    for (let i = 0; i < textLines.length; i++) {
      textLineToRenderedStart.push(renderedIdx);
      const lineLen = Math.max(1, visibleWidth(textLines[i] || ""));
      const wrappedCount = Math.ceil(lineLen / layoutWidth);
      renderedIdx += wrappedCount;
    }

    // Highlight the selected ranges
    for (let textLine = range.start.line; textLine <= range.end.line; textLine++) {
      const lineText = textLines[textLine] || "";
      const renderedStart = textLineToRenderedStart[textLine];
      if (renderedStart === undefined) continue;

      let selStartCol: number;
      let selEndCol: number;

      if (range.linewise) {
        selStartCol = 0;
        selEndCol = visibleWidth(lineText);
      } else {
        selStartCol =
          textLine === range.start.line ? displayColumn(lineText, range.start.col) : 0;
        selEndCol =
          textLine === range.end.line
            ? displayColumn(lineText, range.end.col + 1)
            : visibleWidth(lineText);
      }

      // Apply highlighting across wrapped lines
      const lineLen = Math.max(1, visibleWidth(lineText));
      const wrappedCount = Math.ceil(lineLen / layoutWidth);

      for (let wrap = 0; wrap < wrappedCount; wrap++) {
        const rIdx = renderedStart + wrap;
        if (rIdx >= renderedLines.length - 1) break; // don't touch bottom border

        const wrapStartCol = wrap * layoutWidth;
        const wrapEndCol = wrapStartCol + layoutWidth;

        // Intersection of selection with this wrapped segment
        const hlStart = Math.max(selStartCol, wrapStartCol) - wrapStartCol;
        const hlEnd = Math.min(selEndCol, wrapEndCol) - wrapStartCol;

        if (hlStart < hlEnd) {
          // Offset by paddingX for left padding
          renderedLines[rIdx] = highlightRenderedLine(
            renderedLines[rIdx]!,
            hlStart + paddingX,
            hlEnd + paddingX,
          );
        }
      }
    }
  }
}

/**
 * Detect an escape sequence at position `pos` in `str`.
 * Returns the length of the escape sequence, or 0 if none found.
 *
 * Handles:
 * - CSI sequences: \x1b[ ... m/G/K/H/J
 * - OSC sequences: \x1b] ... BEL or \x1b] ... ST(\x1b\\)
 * - APC sequences: \x1b_ ... BEL or \x1b_ ... ST(\x1b\\)
 */
function escapeSeqLength(str: string, pos: number): number {
  if (pos >= str.length || str[pos] !== "\x1b") return 0;
  const next = str[pos + 1];

  // CSI: \x1b[ ... terminator
  if (next === "[") {
    let j = pos + 2;
    while (j < str.length && !/[mGKHJ]/.test(str[j]!)) j++;
    if (j < str.length) return j + 1 - pos;
    return 0;
  }

  // OSC: \x1b] ... BEL or ST
  if (next === "]") {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07") return j + 1 - pos;
      if (str[j] === "\x1b" && str[j + 1] === "\\") return j + 2 - pos;
      j++;
    }
    return 0;
  }

  // APC: \x1b_ ... BEL or ST
  if (next === "_") {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07") return j + 1 - pos;
      if (str[j] === "\x1b" && str[j + 1] === "\\") return j + 2 - pos;
      j++;
    }
    return 0;
  }

  return 0;
}

/**
 * Insert reverse-video ANSI codes into a rendered line at specific visible column positions.
 * Properly handles CSI, OSC, and APC escape sequences (including CURSOR_MARKER).
 *
 * When the cursor falls inside the highlighted range, the editor's cursor rendering
 * inserts `\x1b[0m` (full reset) after the cursor character, which would kill the
 * reverse video for the rest of the selection. We detect this and re-inject `\x1b[7m`
 * after any SGR reset that falls within the highlighted range.
 *
 * `startVisCol` and `endVisCol` are 0-indexed visible column positions to highlight.
 */
function highlightRenderedLine(
  line: string,
  startVisCol: number,
  endVisCol: number,
): string {
  let result = "";
  let visCol = 0;
  let i = 0;
  let started = false;
  let ended = false;

  while (i < line.length) {
    // Check for any escape sequence (CSI, OSC, APC)
    const seqLen = escapeSeqLength(line, i);
    if (seqLen > 0) {
      // Insert highlight markers before this escape sequence if needed
      if (!started && visCol >= startVisCol) {
        result += "\x1b[7m";
        started = true;
      }
      if (started && !ended && visCol >= endVisCol) {
        result += "\x1b[27m";
        ended = true;
      }

      const seq = line.substring(i, i + seqLen);
      result += seq;

      // If we're inside the highlight range and this is a SGR reset (\x1b[0m),
      // re-inject reverse video to keep the selection highlighted.
      // The editor's cursor rendering uses \x1b[0m after the cursor character,
      // which would otherwise kill our reverse video.
      if (started && !ended && isResetSequence(seq)) {
        result += "\x1b[7m";
      }

      i += seqLen;
      continue;
    }

    // Insert highlight markers at the right visible positions
    if (!started && visCol === startVisCol) {
      result += "\x1b[7m";
      started = true;
    }
    if (started && !ended && visCol === endVisCol) {
      result += "\x1b[27m";
      ended = true;
    }

    const codePoint = line.codePointAt(i);
    const character = codePoint === undefined ? "" : String.fromCodePoint(codePoint);
    result += character;
    visCol += visibleWidth(character);
    i += character.length || 1;
  }

  // Close highlight if we reached end of line before endVisCol
  if (started && !ended) {
    result += "\x1b[27m";
  }

  return result;
}

/**
 * Check if an ANSI sequence is an SGR reset that would clear reverse video.
 * Matches \x1b[0m and \x1b[m (both are full SGR resets).
 */
function isResetSequence(seq: string): boolean {
  return seq === "\x1b[0m" || seq === "\x1b[m";
}
