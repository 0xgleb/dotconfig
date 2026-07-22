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
  const marker = `[Image ${state.nextId}]`;
  const redaction = redactTemporaryScreenshotForEditor(text, marker);
  if (!redaction) return { text, state };
  return {
    text: redaction.displayText,
    state: {
      nextId: state.nextId + 1,
      paths: new Map([...state.paths, [marker, redaction.pathText]]),
    },
  };
};

export const expandEditorScreenshots: (text: string, state: EditorAttachmentState) => string = (text, state) => {
  let expanded = text;
  for (const [marker, path] of state.paths) expanded = expanded.replaceAll(marker, path);
  return expanded;
};
