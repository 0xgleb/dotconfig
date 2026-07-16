import { Data, Effect } from "effect";

export type ReadOutput =
  | { readonly kind: "missing" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image" };

export type ReadRenderMode = "partial" | "collapsed" | "expanded";

export class ReadRenderError extends Data.TaggedError("ReadRenderError")<{
  message: string;
}> {}

export function readResultPresentation(
  output: ReadOutput,
  mode: ReadRenderMode,
): Effect.Effect<string, ReadRenderError> {
  if (mode === "partial") return Effect.succeed("Reading…");
  if (output.kind === "missing") return Effect.fail(new ReadRenderError({ message: "No content" }));
  if (output.kind === "image") return Effect.succeed("Image loaded");
  if (output.text.startsWith("Error")) {
    return Effect.fail(new ReadRenderError({ message: output.text.split("\n")[0] }));
  }
  return Effect.succeed(mode === "expanded" ? output.text : "done");
}
