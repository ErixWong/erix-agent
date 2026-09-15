import { textFromUserMessage } from "./messages.js";

export function capTaskBrief(value, limit = 500) {
  return Array.from(String(value ?? "")).slice(0, limit).join("");
}

export function taskBriefFromMessages(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messages[index]?.role === "user"
      ? textFromUserMessage(messages[index])
      : "";
    // Raw chat fallback stays short to bound prompt size.
    if (text.trim() !== "") return capTaskBrief(text, 500);
  }
  return "";
}

export function resolveTaskBrief({ task, context, messages }) {
  const explicitTask = typeof task === "string" && task.trim() !== ""
    ? task.trim()
    : undefined;
  const contextTask = typeof context?.task === "string" && context.task.trim() !== ""
    ? context.task.trim()
    : undefined;
  // Hosts compose explicit briefs from a task directory, README digest, and latest
  // instruction; preserve a larger trusted budget for that host-authored context.
  if (explicitTask !== undefined) return capTaskBrief(explicitTask, 1500);
  if (contextTask !== undefined) return capTaskBrief(contextTask, 1500);
  return taskBriefFromMessages(messages);
}
