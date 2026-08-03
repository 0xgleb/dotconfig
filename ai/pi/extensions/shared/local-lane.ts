/**
 * The free local dispatch lane is identified by its model provider. Sessions
 * on this lane are trusted only with triage and routing: extensions use this
 * to swap semantic classification for deterministic policy and to steer
 * remote turns toward routing instead of answering.
 */
export const isLocalDispatchProvider = (provider: string | undefined): boolean =>
  provider === "ollama";
