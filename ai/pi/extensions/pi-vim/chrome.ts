import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const fillToWidth = (prefix: string, suffix: string, width: number): string => {
  const available = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
  return `${prefix}${"━".repeat(available)}${suffix}`;
};

export const promptChromeTopLine = (width: number): string => {
  const label = truncateToWidth("╼ PROMPT  ", Math.max(0, width), "");
  return fillToWidth(label, "", width);
};

export const promptChromeBottomLine = (width: number, label: string): string => {
  const suffix = truncateToWidth(` ${label} ╾`, Math.max(0, width), "");
  return fillToWidth("", suffix, width);
};
