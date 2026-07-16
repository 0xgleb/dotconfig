import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { readResultPresentation, type ReadOutput } from "./presentation.ts";

export default function compactRead(pi: ExtensionAPI): void {
  const originalRead = createReadTool(process.cwd());

  pi.registerTool({
    name: "read",
    label: "read",
    description: originalRead.description,
    parameters: originalRead.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      return originalRead.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("read "));
      text += theme.fg("accent", args.path);
      if (args.offset || args.limit) {
        const ranges = [
          args.offset ? `offset=${args.offset}` : undefined,
          args.limit ? `limit=${args.limit}` : undefined,
        ].filter((part): part is string => part !== undefined);
        text += theme.fg("dim", ` (${ranges.join(", ")})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const content = result.content[0];
      const output: ReadOutput =
        content?.type === "text"
          ? { kind: "text", text: content.text }
          : content?.type === "image"
            ? { kind: "image" }
            : { kind: "missing" };
      const mode = isPartial ? "partial" : expanded ? "expanded" : "collapsed";
      const presentation = readResultPresentation(output, mode).pipe(
        Effect.match({
          onFailure: ({ message }) => theme.fg("error", message),
          onSuccess: (text) => theme.fg(expanded ? "dim" : "success", text),
        }),
      );
      return new Text(Effect.runSync(presentation), 0, 0);
    },
  });
}
