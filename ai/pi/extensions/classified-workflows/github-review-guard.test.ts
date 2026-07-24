import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { githubReviewGuard } from "./github-review-guard.ts";

const decisionFor = (command: string, cwd = "/repo") => githubReviewGuard("bash", { command }, cwd);

test("blocks review verdict commands and non-empty top-level body fields", async () => {
  assert.equal((await decisionFor("gh pr review 42 --approve"))?.verdict, "block");
  assert.equal(
    (await decisionFor("gh api graphql -f query='mutation { submitPullRequestReview(input: {}) { clientMutationId } }'"))
      ?.verdict,
    "block",
  );
  assert.equal(
    (await decisionFor("gh api graphql -f query='mutation { updatePullRequestReview(input: {}) { clientMutationId } }' -f body='[agent:review-pr] reviewed abc'"))
      ?.verdict,
    "block",
  );
});

test("allows normal classification of exact empty-body cleanup", async () => {
  assert.equal(
    await decisionFor(
      "gh api graphql -f query='mutation($id: ID!) { updatePullRequestReview(input: {pullRequestReviewId: $id, body: \"\"}) { clientMutationId } }' -f body=''",
    ),
    null,
  );
});

test("inspects literal REST review payloads before publication", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-review-guard-"));
  try {
    const safe = path.join(directory, "safe.json");
    const unsafe = path.join(directory, "unsafe.json");
    const submitted = path.join(directory, "submitted.json");
    await writeFile(safe, JSON.stringify({ body: "", comments: [{ path: "src/a.ts", line: 1, body: "fix" }] }));
    await writeFile(unsafe, JSON.stringify({ body: "reviewed commit abc", comments: [] }));
    await writeFile(submitted, JSON.stringify({ body: "", event: "COMMENT", comments: [] }));

    assert.equal(await decisionFor(`gh api repos/o/r/pulls/1/reviews --input ${safe}`), null);
    assert.equal((await decisionFor(`gh api repos/o/r/pulls/1/reviews --input ${unsafe}`))?.verdict, "block");
    assert.equal((await decisionFor(`gh api repos/o/r/pulls/1/reviews --input ${submitted}`))?.verdict, "block");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts the documented one-shot empty-body heredoc while rejecting embedded body text", async () => {
  const safe = `review_json=$(mktemp -t review.json)\ncat > "$review_json" <<'JSON'\n{"body":"","comments":[{"body":"inline only"}]}\nJSON\ngh api repos/o/r/pulls/1/reviews --input "$review_json"`;
  const unsafe = `review_json=$(mktemp -t review.json)\ncat > "$review_json" <<'JSON'\n{"body":"reviewed commit abc","comments":[]}\nJSON\ngh api repos/o/r/pulls/1/reviews --input "$review_json"`;
  assert.equal(await decisionFor(safe), null);
  assert.equal((await decisionFor(unsafe))?.verdict, "block");
});

test("fails closed when an opaque review payload cannot be inspected", async () => {
  assert.equal(
    (await decisionFor('gh api repos/o/r/pulls/1/reviews --input "$review_json"'))?.verdict,
    "block",
  );
});
