/**
 * Telegram group ids are never typed by a human: they are opaque negative
 * integers the API hands out, and pinning one into configuration means editing
 * the daemon every time a chat is recreated. The registry is the discovery
 * record instead - the owner speaks in a group once, the daemon learns the id,
 * and everything downstream addresses that chat by its normalized name.
 */
export interface RegisteredChat {
  readonly id: number
  readonly title: string
}

export type ChatRegistry = Readonly<Record<string, RegisteredChat>>

export const MAX_CHAT_NAME_CHARACTERS = 64
export const MAX_CHAT_TITLE_CHARACTERS = 128
export const MAX_REGISTERED_CHATS = 32

export const emptyChatRegistry: ChatRegistry = {}

/**
 * Group titles carry emoji, punctuation, and mixed scripts that no agent will
 * reproduce byte for byte in a relay frame. The name is what both sides can
 * agree on: letters and digits of any script, everything else collapsed to a
 * single separator.
 */
export const normalizedChatName = (title: string): string | undefined => {
  const name = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .slice(0, MAX_CHAT_NAME_CHARACTERS)
    .replace(/^-+|-+$/gu, "")
  return name || undefined
}

/**
 * Only groups and supergroups belong in the registry. Telegram gives them
 * negative ids and private chats positive ones, so a non-negative id is a DM
 * that must never become a routing target.
 */
export const isGroupChatId = (id: unknown): id is number =>
  typeof id === "number" && Number.isSafeInteger(id) && id < 0

/**
 * The state file is attacker-adjacent by construction: it is rewritten on every
 * update and read back on every start. A single corrupt entry drops out of the
 * registry rather than failing the load, because losing one routing target is
 * recoverable and refusing to start is not.
 */
export const decodeChatRegistry = (candidate: unknown): ChatRegistry => {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return emptyChatRegistry
  }
  const chats: Record<string, RegisteredChat> = {}
  for (const [name, entry] of Object.entries(
    candidate as Readonly<Record<string, unknown>>,
  )) {
    if (Object.keys(chats).length >= MAX_REGISTERED_CHATS) break
    const chat = decodeRegisteredChat(name, entry)
    if (chat) chats[name] = chat
  }
  return chats
}

export type ChatRegistration =
  | { readonly outcome: "unchanged" }
  | {
      readonly outcome: "recorded"
      readonly name: string
      readonly chats: ChatRegistry
    }

export interface DiscoveredChat {
  readonly id: number
  readonly title: string
}

/**
 * Discovery is idempotent: a chat the registry already holds under the same id
 * and title reports `unchanged`, so a quiet group does not rewrite the state
 * file on every message. A renamed chat moves rather than duplicates - one id
 * is one name, or the same group answers to a name nobody uses any more. New
 * chats stop at MAX_REGISTERED_CHATS, which a rename can never trip because it
 * frees the entry it replaces.
 */
export const recordGroupChat = (
  chats: ChatRegistry,
  chat: DiscoveredChat,
): ChatRegistration => {
  if (!isGroupChatId(chat.id)) return { outcome: "unchanged" }
  const title = boundedChatTitle(chat.title)
  const name = title ? normalizedChatName(title) : undefined
  if (!title || !name) return { outcome: "unchanged" }

  const existing = chats[name]
  if (existing && existing.id === chat.id && existing.title === title) {
    return { outcome: "unchanged" }
  }
  const retained = Object.fromEntries(
    Object.entries(chats).filter(
      ([key, entry]) => key !== name && entry.id !== chat.id,
    ),
  )
  if (Object.keys(retained).length >= MAX_REGISTERED_CHATS) {
    return { outcome: "unchanged" }
  }
  return {
    outcome: "recorded",
    name,
    chats: { ...retained, [name]: { id: chat.id, title } },
  }
}

export const resolveChat = (
  chats: ChatRegistry,
  name: string,
): RegisteredChat | undefined => {
  const normalized = normalizedChatName(name)
  return normalized ? chats[normalized] : undefined
}

export const knownChatNames = (chats: ChatRegistry): readonly string[] =>
  Object.keys(chats).sort()

const boundedChatTitle = (title: unknown): string | undefined => {
  if (typeof title !== "string") return undefined
  const bounded = title
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
  return bounded && bounded.length <= MAX_CHAT_TITLE_CHARACTERS
    ? bounded
    : undefined
}

/**
 * A key that is not the normalization of itself was not written by this
 * module. Dropping it also keeps prototype-shaped keys such as `__proto__` out
 * of the registry, since none of them survive normalization unchanged.
 */
const decodeRegisteredChat = (
  name: string,
  entry: unknown,
): RegisteredChat | undefined => {
  if (normalizedChatName(name) !== name) return undefined
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return undefined
  }
  const candidate = entry as Readonly<Record<string, unknown>>
  if (!isGroupChatId(candidate.id)) return undefined
  const title = boundedChatTitle(candidate.title)
  return title ? { id: candidate.id, title } : undefined
}
