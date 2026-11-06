export const TELEGRAM_RESUME_TAG = "[Telegram /resume]\n"

export const TELEGRAM_RESUME_REQUEST = `${TELEGRAM_RESUME_TAG}Inspect your task list and continue the highest-ranked active authorized work. If you are stuck, ask the owner via ask_user how to get unstuck.`

export const TELEGRAM_RESUME_EVENT = "pi:authenticated-telegram-resume"

export interface AuthenticatedTelegramResume {
  readonly sessionId: string
}
