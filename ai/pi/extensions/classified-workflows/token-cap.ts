const OUTPUT_TOKEN_FIELDS = ["max_output_tokens", "max_completion_tokens", "max_tokens"] as const;
const TOKEN_ESTIMATE_CHARACTERS = 2;
const TOKEN_ACCOUNTING_RESERVE = 512;
const MAX_WORKFLOW_CHILD_TOKEN_LIMIT = 5_000_000;

export const WORKFLOW_CHILD_TOKEN_LIMIT_ENV = "PI_INTERNAL_WORKFLOW_CHILD_TOKEN_LIMIT";

export interface CappedProviderPayload {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly estimatedPromptTokens: number;
  readonly outputTokenLimit: number;
  readonly enforcement: "provider" | "process-measured";
}

export interface ProviderTokenCapOptions {
  readonly allowProcessMeasuredOutput?: boolean;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const workflowChildTokenLimit = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_WORKFLOW_CHILD_TOKEN_LIMIT) {
    throw new Error("Workflow child token environment limit is malformed");
  }
  return parsed;
};

export const capProviderOutputTokens = (
  payload: unknown,
  tokenLimit: number,
  options: ProviderTokenCapOptions = {},
): CappedProviderPayload => {
  if (!isRecord(payload)) throw new Error("Workflow child provider payload is malformed");
  if (!Number.isSafeInteger(tokenLimit) || tokenLimit < 1) {
    throw new Error("Workflow child token limit is malformed");
  }
  const encoded = JSON.stringify(payload);
  const estimatedPromptTokens = Math.ceil(encoded.length / TOKEN_ESTIMATE_CHARACTERS);
  const availableOutputTokens = tokenLimit - estimatedPromptTokens - TOKEN_ACCOUNTING_RESERVE;
  if (availableOutputTokens < 1) {
    throw new Error(
      `Workflow child prompt estimate already consumes token limit (${estimatedPromptTokens}+${TOKEN_ACCOUNTING_RESERVE}/${tokenLimit})`,
    );
  }
  const field = OUTPUT_TOKEN_FIELDS.find((candidate) => Object.hasOwn(payload, candidate));
  if (!field) {
    if (!options.allowProcessMeasuredOutput) {
      throw new Error("Workflow child provider payload has no recognized output-token field");
    }
    return {
      payload,
      estimatedPromptTokens,
      outputTokenLimit: availableOutputTokens,
      enforcement: "process-measured",
    };
  }
  const configured = payload[field];
  if (typeof configured !== "number" || !Number.isSafeInteger(configured) || configured < 1) {
    throw new Error(`Workflow child provider payload ${field} is malformed`);
  }
  const outputTokenLimit = Math.min(configured, availableOutputTokens);
  return {
    payload: { ...payload, [field]: outputTokenLimit },
    estimatedPromptTokens,
    outputTokenLimit,
    enforcement: "provider",
  };
};
