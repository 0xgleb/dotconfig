export const REVIEW_DUTY_PROFILES = [
  "st0x-review",
  "dataclique-review",
  "personal-review",
] as const

export type ReviewDutyProfile = (typeof REVIEW_DUTY_PROFILES)[number]

const PROFILE_OWNERS: Readonly<Record<ReviewDutyProfile, readonly string[]>> = {
  "st0x-review": ["st0x-technology", "rainlanguage"],
  "dataclique-review": ["dataclique"],
  "personal-review": ["0xgleb"],
}

const AUTOMATIC_REPOSITORIES: Readonly<
  Partial<Record<ReviewDutyProfile, string>>
> = {
  "dataclique-review": "dataclique/yielduck",
  "personal-review": "0xgleb/dotconfig",
}

export const repositoryAllowedForProfile = (
  profile: ReviewDutyProfile,
  repository: string,
): boolean =>
  PROFILE_OWNERS[profile].includes(repository.split("/", 1)[0] ?? "")

export const automaticRepositoryForProfile = (
  profile: ReviewDutyProfile,
): string | undefined => AUTOMATIC_REPOSITORIES[profile]
