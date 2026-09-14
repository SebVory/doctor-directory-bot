/**
 * Runs the real STT transcripts through the agent and reports what the model
 * extracted, what the store resolved, and how the turn was classified.
 *
 * Billed: one agent turn per utterance. Re-running findDoctors locally with the
 * arguments the model passed is free and shows the store's view of the same call.
 */
import { readFileSync } from "node:fs";
import { classify } from "../evals/behaviour.js";
import { runTurn } from "../src/doctor-agent.js";
import { findDoctors } from "../src/doctor-store.js";

type Entry = { utterance: string; expectation: string };

function parse(path: string): { openings: Entry[]; sections: Map<string, Entry[]> } {
  const lines = readFileSync(path, "utf8").split("\n");
  const openings: Entry[] = [];
  const sections = new Map<string, Entry[]>();
  let current: Entry[] | null = null;

  for (const [i, line] of lines.entries()) {
    if (line.startsWith("## ")) {
      current = [];
      sections.set(line.slice(3).trim(), current);
      continue;
    }
    if (line.startsWith("#") || line.startsWith("=>") || line.trim().length === 0) continue;
    const next = lines[i + 1] ?? "";
    const entry = { utterance: line.trim(), expectation: next.startsWith("=>") ? next.slice(2).trim() : "" };
    (current ?? openings).push(entry);
  }
  return { openings, sections };
}

/** Best-effort read of the Czech expectation into an outcome we can compare against. */
function expectedOutcome(expectation: string): string | null {
  const t = expectation.toLowerCase();
  if (t.includes("155")) return "emergency";
  if (t.includes("not_found")) return "not_found";
  if (t.includes("confirm") || t.includes("potvrd")) return "confirm_name";
  if (t.includes("bez toolu") || t.includes("out_of_scope")) return "out_of_scope";
  if (t.includes("ask_clarification") || t.includes("ask (") || t.includes("→ ask")) return "ask_clarification";
  return null;
}

const S = (v: unknown, n: number): string => String(v ?? "—").slice(0, n).padEnd(n);

async function report(label: string, utterance: string, expectation: string, history: Awaited<ReturnType<typeof runTurn>>["messages"]) {
  const result = await runTurn(utterance, history, { trace: false });
  const call = result.toolCalls.find((c) => c.name === "find_doctors");
  const args = (call?.input ?? {}) as Record<string, string | null>;

  let store = "no tool call";
  if (call !== undefined) {
    const r = findDoctors({
      surname: args["surname"] ?? undefined,
      first_name: args["first_name"] ?? undefined,
      speciality: args["speciality"] ?? undefined,
      city: args["city"] ?? undefined,
      language: args["language"] ?? undefined,
    });
    const top = r.matches[0];
    store = `cand=${String(r.candidates).padStart(4)} unres=[${r.unresolved.join(",")}] res=${r.resolved.speciality ?? "-"}/${r.resolved.city ?? "-"} top=${top ? `${top.first_name} ${top.last_name} ${top.score.toFixed(2)}` : "none"}`;
  }

  const outcome = classify(result.answer, result.toolCalls);
  const want = expectedOutcome(expectation);
  const verdict = want === null ? "  ? " : outcome === want ? "PASS" : "FAIL";

  console.log(
    `${verdict} ${S(label, 4)}${S(utterance, 40)} | ${S(`${args["surname"] ?? "-"}/${args["first_name"] ?? "-"}/${args["speciality"] ?? "-"}/${args["city"] ?? "-"}`, 42)} | ${S(store, 74)} | ${S(outcome, 18)} | want=${want ?? "(free text)"}`,
  );
  if (verdict === "FAIL" || want === null) console.log(`         expectation: ${expectation}`);
  return result;
}

const { openings, sections } = parse("./evals/stt-transcripts.txt");

console.log(`\n══════ OPENING UTTERANCES (${openings.length}) ══════\n`);
let pass = 0, fail = 0, unknown = 0;
for (const [i, e] of openings.entries()) {
  const r = await report(String(i + 1), e.utterance, e.expectation, []);
  const want = expectedOutcome(e.expectation);
  if (want === null) unknown++;
  else if (classify(r.answer, r.toolCalls) === want) pass++;
  else fail++;
}
console.log(`\nopenings: ${pass} pass, ${fail} fail, ${unknown} free-text expectations\n`);

console.log(`══════ CONVERSATIONS (${sections.size}) ══════`);
// Each section's first transcript is replayed as a follow-up to an opening that
// provokes the question that section answers.
const SETUP: Record<string, string> = {
  mesto: "Dobrý den, já vás zdravím, chtěl bych se zeptat, jestli máte číslo na doktora Dumistrésku.",
  jmen: "Dobrý den, já vás zdravím, chtěl bych se zeptat, jestli máte číslo na doktora Dumistrésku.",
  oboru: "Dobrý den, já vás zdravím, chtěl bych se zeptat, jestli máte číslo na doktora Dumistrésku.",
  Potvrzeni: "Dobrý den, potřeboval bych kontakt na paní Váselysku.",
  nalezeni: "Dobrý den, já vás zdravím, chtěl bych se zeptat, jestli máte číslo na doktora Dumistrésku.",
  Zmena: "Dobrý den, já vás zdravím, chtěl bych se zeptat, jestli máte číslo na doktora Dumistrésku.",
};
for (const [name, entries] of sections) {
  const key = Object.keys(SETUP).find((k) => name.toLowerCase().includes(k.toLowerCase())) ?? "mesto";
  console.log(`\n── ${name}`);
  let history: Awaited<ReturnType<typeof runTurn>>["messages"] = [];
  const setup = SETUP[key] ?? "";
  const first = await report("t1", setup, "(setup turn)", history);
  history = first.messages;
  for (const e of entries.slice(0, 2)) {
    const r = await report("t+", e.utterance, e.expectation, history);
    history = r.messages;
  }
}
