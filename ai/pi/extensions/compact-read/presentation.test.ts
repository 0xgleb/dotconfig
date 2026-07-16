import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Either } from "effect";
import { readResultPresentation } from "./presentation.ts";

test("collapsed reads hide file contents while expanded reads reveal them", async () => {
  const output = { kind: "text" as const, text: "first line\nsecond line" };

  assert.equal(await Effect.runPromise(readResultPresentation(output, "collapsed")), "done");
  assert.equal(await Effect.runPromise(readResultPresentation(output, "expanded")), output.text);
});

test("partial and image reads retain useful status", async () => {
  assert.equal(
    await Effect.runPromise(readResultPresentation({ kind: "missing" }, "partial")),
    "Reading…",
  );
  assert.equal(
    await Effect.runPromise(readResultPresentation({ kind: "image" }, "collapsed")),
    "Image loaded",
  );
});

test("missing and failed read output use the typed error channel", async () => {
  const missing = await Effect.runPromise(
    Effect.either(readResultPresentation({ kind: "missing" }, "collapsed")),
  );
  const failed = await Effect.runPromise(
    Effect.either(
      readResultPresentation(
        { kind: "text", text: "Error: cannot read\ninternal detail" },
        "collapsed",
      ),
    ),
  );

  assert.equal(Either.isLeft(missing), true);
  assert.equal(Either.isLeft(failed), true);
  if (Either.isLeft(missing)) assert.equal(missing.left.message, "No content");
  if (Either.isLeft(failed)) assert.equal(failed.left.message, "Error: cannot read");
});
