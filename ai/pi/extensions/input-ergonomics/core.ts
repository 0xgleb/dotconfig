import { extname, normalize } from "node:path";

export const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

export interface TemporaryScreenshot {
  readonly path: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly remainingText: string;
}

const parseScreenshotPath: (text: string) => Omit<TemporaryScreenshot, "remainingText"> | undefined = (text) => {
  const trimmed = text.trim();
  const quoted =
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  const path = (quoted ? trimmed.slice(1, -1) : trimmed).replace(/\\ /g, " ");
  if (path.includes("\\") || !isAllowedTemporaryPath(path)) return undefined;
  const mimeType = mimeTypeForExtension(imageExtension(path));
  return mimeType ? { path, mimeType } : undefined;
};

export const parseTemporaryScreenshot: (text: string) => TemporaryScreenshot | undefined = (text) => {
  const lines = text.split("\n");
  const matches = lines.flatMap((line, index) => {
    const screenshot = parseScreenshotPath(line);
    return screenshot ? [{ index, screenshot }] : [];
  });
  if (matches.length !== 1) return undefined;
  const [{ index, screenshot }] = matches;
  return {
    ...screenshot,
    remainingText: lines.filter((_line, lineIndex) => lineIndex !== index).join("\n").trim(),
  };
};

export const validateImageMagic: (bytes: Uint8Array, mimeType: TemporaryScreenshot["mimeType"]) => boolean = (
  bytes,
  mimeType,
) => {
  switch (mimeType) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    case "image/webp":
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.slice(8), [0x57, 0x45, 0x42, 0x50]);
  }
};

export const isAllowedTemporaryPath: (path: string) => boolean = (path) => {
  const normalized = normalize(path);
  return /^\/var\/folders\/[^/]+\/[^/]+\/(?:T|TemporaryItems)\//.test(normalized);
};

export const attachmentPrompt: (existingText: string) => string = (existingText) => {
  const remaining = existingText.trim();
  return remaining || "Inspect the attached screenshot.";
};

const MIME_TYPES: Readonly<Record<string, TemporaryScreenshot["mimeType"]>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const mimeTypeForExtension: (
  extension: string,
) => TemporaryScreenshot["mimeType"] | undefined = (extension) => MIME_TYPES[extension.toLowerCase()];

export const imageExtension: (path: string) => string = (path) => extname(path).toLowerCase();

const startsWith: (bytes: Uint8Array, prefix: ReadonlyArray<number>) => boolean = (bytes, prefix) =>
  prefix.length <= bytes.length && prefix.every((byte, index) => bytes[index] === byte);
