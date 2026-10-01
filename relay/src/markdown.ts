// Builds the GitHub issue title and Markdown body for one feedback item.

import type { Feedback } from "./validate";

/** GitHub refuses issue bodies over 65,536 characters; stay well below. */
export const MAX_BODY_CHARS = 60_000;
const TITLE_CHARS = 80;
const SHA = /^[0-9a-f]{7,40}$/i;

const ZWSP = "\u200b";

/** Put a zero-width space after every @ so "@someone" never pings anyone. */
export function neutraliseMentions(text: string): string {
  return text.replace(/@/g, `@${ZWSP}`);
}

/** Break issue references (#12, owner/repo#3, GH-12) with a zero-width space so GitHub neither
 * links them nor adds a "mentioned this" note to the other issue. */
export function neutraliseRefs(text: string): string {
  return text.replace(/#(?=\d)/g, `#${ZWSP}`).replace(/\bGH-(?=\d)/gi, (m) => `${m.slice(0, 2)}${ZWSP}-`);
}

/** The user's message, shown exactly as typed inside a code block: nothing in it renders as
 * Markdown or HTML, and URLs, #12-style references and @-mentions do nothing. The fence is
 * longer than any backtick run in the message, so it can't be closed from inside. */
export function messageMarkdown(text: string): string {
  const safe = neutraliseMentions(text);
  const fence = fenceFor(safe);
  return `${fence}text\n${safe}\n${fence}`;
}

/** Text safe inside one table cell or list item: one line, Markdown punctuation escaped,
 * mentions and issue references neutralised. */
export function inline(text: string): string {
  const oneLine = text.replace(/\r?\n|\r/g, " ");
  return neutraliseRefs(neutraliseMentions(oneLine.replace(/[\\`*_[\]<>|#~!]/g, (c) => `\\${c}`)));
}

/** The hidden line that ties an issue to its feedback id (used to find it again on a retry). */
export function feedbackMarker(id: string): string {
  return `<!-- feedback-id: ${id} -->`;
}

/** A backtick fence longer than any backtick run inside the text. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

export function issueTitle(fb: Feedback): string {
  const label = fb.category.charAt(0).toUpperCase() + fb.category.slice(1);
  const firstLine = (fb.message.split(/\r?\n|\r/)[0] ?? "").trim();
  const chars = Array.from(firstLine);
  const short = chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS - 1).join("").trimEnd()}…` : firstLine;
  // Titles are plain text, but neutralise mentions and references anyway: cheap, and safe
  // wherever GitHub or an email client does render them.
  return `[${label}] ${neutraliseRefs(neutraliseMentions(short))}`;
}

export interface BodyLinks {
  codeRepo: string;
  screenshotUrl: string | null;
}

function buildCell(buildId: string, codeRepo: string): string {
  if (!SHA.test(buildId)) return inline(buildId);
  return `[\`${buildId.slice(0, 12)}\`](https://github.com/${codeRepo}/commit/${buildId})`;
}

/** Keep the last lines of the log that fit in `budget` characters. */
function tailToFit(log: string, budget: number): string {
  if (log.length <= budget) return log;
  const note = "[earlier lines cut to fit the issue]\n";
  let cut = log.slice(log.length - Math.max(0, budget - note.length));
  const newline = cut.indexOf("\n");
  if (newline !== -1) cut = cut.slice(newline + 1);
  return note + cut;
}

export function issueBody(fb: Feedback, links: BodyLinks): string {
  const rows: [string, string][] = [
    ["Created (UTC)", inline(fb.createdAtText)],
    ["Local time", inline(fb.localTime) || "—"],
    ["App version", inline(fb.appVersion)],
    ["Build", buildCell(fb.buildId, links.codeRepo)],
    ["Route", inline(fb.route) || "—"],
    ["Install ID", `\`${fb.installId}\``],
    ...fb.environment.map(([k, v]): [string, string] => [inline(k), inline(v) || "—"]),
  ];

  const parts: string[] = [messageMarkdown(fb.message), "### Details", ["| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join("\n")];

  if (fb.errors.length > 0) {
    parts.push("### Recent errors", fb.errors.map((e) => `- ${inline(e.at)} · ${inline(e.kind)} · ${inline(e.message)}`).join("\n"));
  }

  if (links.screenshotUrl) {
    parts.push("### Screenshot", `![Screenshot](${links.screenshotUrl}?raw=true)\n\n[Open the screenshot](${links.screenshotUrl})`);
  }

  const marker = feedbackMarker(fb.id);

  if (fb.logTail.trim()) {
    const fixed = [...parts, marker].join("\n\n").length;
    const overhead = 200; // <details> wrapper and fences
    const log = tailToFit(fb.logTail.replace(/\n+$/, ""), MAX_BODY_CHARS - fixed - overhead);
    const fence = fenceFor(log);
    parts.push(`<details><summary>Server log (last lines)</summary>\n\n${fence}text\n${log}\n${fence}\n\n</details>`);
  }

  parts.push(marker);
  return parts.join("\n\n") + "\n";
}
