import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * Registers the local Ollama provider so its models appear in the selector
 * immediately (models.json is Home Manager generated and only updates on a
 * rebuild; this extension keeps the local lane usable without one). The
 * server itself is started on demand by `fj clanker --dispatcher`.
 */
export default function (pi: ExtensionAPI) {
  pi.registerProvider("ollama", {
    name: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    apiKey: "ollama",
    api: "openai-completions",
    models: [
      {
        id: "qwen3:32b",
        name: "Qwen3 32B (local)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 24576,
        maxTokens: 512,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
      },
    ],
  })
}
