import { redactTemporaryScreenshotForEditor } from "../input-ergonomics/core.ts";

export interface EditorAttachmentState {
  readonly nextId: number;
  readonly paths: ReadonlyMap<string, string>;
}

export const emptyEditorAttachmentState: () => EditorAttachmentState = () => ({ nextId: 1, paths: new Map() });

export const redactEditorScreenshot: (
  text: string,
  state: EditorAttachmentState,
) => { readonly text: string; readonly state: EditorAttachmentState } = (text, state) => {
  let displayText = text;
  let nextId = state.nextId;
  const paths = new Map(state.paths);

  while (true) {
    const marker = `[Image ${nextId}]`;
    const redaction = redactTemporaryScreenshotForEditor(displayText, marker);
    if (!redaction) break;
    displayText = redaction.displayText;
    paths.set(marker, redaction.pathText);
    nextId += 1;
  }

  return nextId === state.nextId
    ? { text, state }
    : { text: displayText, state: { nextId, paths } };
};

export const expandEditorScreenshots: (text: string, state: EditorAttachmentState) => string = (text, state) => {
  let expanded = text;
  for (const [marker, path] of state.paths) expanded = expanded.replaceAll(marker, path);
  return expanded;
};
