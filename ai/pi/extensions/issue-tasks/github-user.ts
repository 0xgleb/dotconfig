import { Schema } from "effect"

export const GitHubUserIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(1024),
  Schema.filter(value => !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value)),
  Schema.brand("GitHubUserId"),
)

export const GitHubUserSchema = Schema.Struct({
  id: GitHubUserIdSchema,
  login: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(100),
    Schema.filter(value => !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value)),
  ),
})

export type GitHubUser = typeof GitHubUserSchema.Type
