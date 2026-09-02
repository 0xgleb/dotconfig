export const MAX_SESSION_ENTRY_BYTES: number
export const MAX_SESSION_LOAD_BYTES: number

export function sessionFileNeedsTrailingNewlineSync(filePath: string): boolean
export function loadBoundedSessionEntriesSync(filePath: string): unknown[]
