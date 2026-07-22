import { extname, normalize } from "node:path";

export const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

export interface TemporaryScreenshot {
  readonly path: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly remainingText: string;
}

export interface ScreenshotEditorRedaction {
  readonly displayText: string;
  readonly pathText: string;
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

const inlineScreenshotMatches: (text: string) => RegExpMatchArray[] = (text) =>
  [...text.matchAll(/\/(?:private\/)?var\/folders\/(?:\\ |[^\s\\])+\.(?:png|jpe?g|gif|webp)/gi)];

export const parseTemporaryScreenshot: (text: string) => TemporaryScreenshot | undefined = (text) => {
  const lines = text.split("\n");
  const matches = lines.flatMap((line, index) => {
    const screenshot = parseScreenshotPath(line);
    return screenshot ? [{ index, screenshot }] : [];
  });
  if (matches.length === 1) {
    const [{ index, screenshot }] = matches;
    return {
      ...screenshot,
      remainingText: lines.filter((_line, lineIndex) => lineIndex !== index).join("\n").trim(),
    };
  }
  if (matches.length > 1) return undefined;

  const inlineMatches = inlineScreenshotMatches(text);
  if (inlineMatches.length !== 1) return undefined;
  const [inline] = inlineMatches;
  if (inline.index === undefined || !inline[0].includes("\\ ")) return undefined;
  const screenshot = parseScreenshotPath(inline[0]);
  if (!screenshot) return undefined;
  const remainingText = `${text.slice(0, inline.index)} ${text.slice(inline.index + inline[0].length)}`
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { ...screenshot, remainingText };
};

export const redactTemporaryScreenshotForEditor: (
  text: string,
  marker: string,
) => ScreenshotEditorRedaction | undefined = (text, marker) => {
  const lines = text.split("\n");
  const lineMatches = lines.flatMap((line, index) => (parseScreenshotPath(line) ? [{ line, index }] : []));
  if (lineMatches.length === 1) {
    const [{ line, index }] = lineMatches;
    return {
      displayText: lines.map((value, lineIndex) => (lineIndex === index ? marker : value)).join("\n"),
      pathText: line,
    };
  }
  if (lineMatches.length > 1) return undefined;

  const inlineMatches = inlineScreenshotMatches(text);
  if (inlineMatches.length !== 1) return undefined;
  const [match] = inlineMatches;
  if (match.index === undefined || !match[0].includes("\\ ") || !parseScreenshotPath(match[0])) return undefined;
  return {
    displayText: `${text.slice(0, match.index)}${marker}${text.slice(match.index + match[0].length)}`,
    pathText: match[0],
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
  return /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/(?:T|TemporaryItems)\//.test(normalized);
};

export const attachmentPrompt: (existingText: string, imageNumber?: number) => string = (existingText, imageNumber = 1) => {
  const remaining = existingText.trim();
  const marker = `[Image ${imageNumber}]`;
  return remaining ? `${remaining}\n\n${marker}` : marker;
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
