import assert from "node:assert/strict"
import test from "node:test"

import { telegramHtmlChunks } from "./telegram-format.ts"

test("Telegram formatting renders bounded Markdown without trusting raw HTML", () => {
  assert.deepEqual(
    telegramHtmlChunks(
      "**37/37 pass**\nRun `resume #33`.\n[Docs](https://example.com/a?x=1&y=2)\n<b>untrusted</b>",
    ),
    [
      '<b>37/37 pass</b>\nRun <code>resume #33</code>.\n<a href="https://example.com/a?x=1&amp;y=2">Docs</a>\n&lt;b&gt;untrusted&lt;/b&gt;',
    ],
  )
})

test("Telegram formatting renders fenced code as native preformatted blocks", () => {
  assert.deepEqual(
    telegramHtmlChunks(
      [
        "Testing code rendering:",
        "",
        "```rust",
        'fn main() { println!("<Piece & Pi>"); }',
        "```",
        "",
        "```typescript",
        "const ready: boolean = true",
        "```",
        "",
        "Inline `review_duty report questionId=11`.",
      ].join("\n"),
    ),
    [
      'Testing code rendering:\n\n<pre><code class="language-rust">fn main() { println!(&quot;&lt;Piece &amp; Pi&gt;&quot;); }</code></pre>\n\n<pre><code class="language-typescript">const ready: boolean = true</code></pre>\n\nInline <code>review_duty report questionId=11</code>.',
    ],
  )
})

test("Telegram formatting chunks large fenced code without breaking HTML tags", () => {
  const chunks = telegramHtmlChunks(
    `\`\`\`rust\n${"let value = 1;\n".repeat(30)}\`\`\``,
    120,
  )

  assert.ok(chunks.length > 1)
  assert.equal(
    chunks.every(chunk => chunk.length <= 120),
    true,
  )
  assert.equal(
    chunks.every(
      chunk =>
        chunk.startsWith('<pre><code class="language-rust">') &&
        chunk.endsWith("</code></pre>") &&
        !chunk.includes("```"),
    ),
    true,
  )
})

test("Telegram formatting leaves an unclosed fence as escaped plain text", () => {
  assert.deepEqual(telegramHtmlChunks("```rust\n<b>unsafe</b>"), [
    "```rust\n&lt;b&gt;unsafe&lt;/b&gt;",
  ])
})

test("Telegram formatting keeps every HTML chunk within the Bot API limit", () => {
  const chunks = telegramHtmlChunks(
    Array.from(
      { length: 20 },
      (_, index) => `**Item ${index}** ${"x".repeat(40)}`,
    ).join("\n"),
    120,
  )

  assert.ok(chunks.length > 1)
  assert.equal(
    chunks.every(chunk => chunk.length <= 120),
    true,
  )
  assert.equal(
    chunks.every(chunk => !chunk.includes("**")),
    true,
  )
})
