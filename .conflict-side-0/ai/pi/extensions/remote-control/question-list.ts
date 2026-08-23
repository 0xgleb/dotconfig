import { identifiedAgentLabel } from "./agent-identity.ts";
import type { BridgeAgent, BridgeQuestion } from "./protocol.ts";

const questionSummary = (question: BridgeQuestion): string =>
  question.question.replace(/\s+/g, " ").trim().slice(0, 240);

export const globalQuestionsText = (
  questions: readonly BridgeQuestion[],
  agents: readonly BridgeAgent[],
): string => {
  if (questions.length === 0) return "No pending Pi questions.";
  const sections = questions.slice(0, 50).map((question) => {
    const agent = agents.find(({ id }) => id === question.agentId);
    const identity = agent
      ? identifiedAgentLabel(agent, agents)
      : "Unavailable Pi agent";
    const heading = question.header?.replace(/\s+/g, " ").trim().slice(0, 80);
    return [
      identity,
      `q${question.questionId}${heading ? ` · ${heading}` : ""}`,
      questionSummary(question),
    ].join("\n");
  });
  return [
    `❓ Pending questions · ${questions.length}`,
    "",
    ...sections.flatMap((section) => [section, ""]),
    ...(questions.length > sections.length
      ? [`${questions.length - sections.length} more questions omitted.`, ""]
      : []),
    "Reply to the original question card to answer its exact qID.",
  ]
    .join("\n")
    .slice(0, 3_900);
};
