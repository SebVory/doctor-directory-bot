/**
 * Runs the real STT transcripts through the matcher and the store with no model
 * in the loop, so it costs nothing and isolates one question: given the fields a
 * competent model would extract, does the lookup find the right doctor?
 *
 * Fields in stt-fields.json are hand-extracted from the verbatim transcripts.
 * Transcripts themselves are never edited.
 */
import { readFileSync } from "node:fs";
import { findDoctors } from "../src/doctor-store.js";

type Entry = {
  utterance: string;
  fields: { surname: string | null; first_name: string | null; speciality: string | null; city: string | null; language: string | null };
  target: { surname: string | null; city: string | null; speciality: string | null };
  note: string;
};

const data = JSON.parse(readFileSync("./evals/stt-fields.json", "utf8")) as {
  openings: Entry[];
  followups: Entry[];
};

const S = (v: unknown, n: number): string => String(v ?? "—").slice(0, n).padEnd(n);
const or = (v: string | null): string | undefined => v ?? undefined;

function run(entries: Entry[], label: string): { hit: number; miss: number; skipped: number } {
  console.log(`\n══════ ${label} ══════\n`);
  let hit = 0, miss = 0, skipped = 0;

  for (const [i, entry] of entries.entries()) {
    const { surname, first_name, speciality, city, language } = entry.fields;
    if (surname === null && first_name === null && speciality === null && city === null) {
      console.log(`  --  ${S(i + 1, 3)}${S(entry.utterance, 44)} | (no lookup — ${entry.note})`);
      skipped += 1;
      continue;
    }

    const r = findDoctors({
      surname: or(surname), first_name: or(first_name),
      speciality: or(speciality), city: or(city), language: or(language),
    });
    const top = r.matches[0];

    // A miss is any target the lookup failed to reach.
    const checks: string[] = [];
    if (entry.target.surname !== null) checks.push(top?.last_name === entry.target.surname ? "" : `surname→${top?.last_name ?? "none"}`);
    if (entry.target.city !== null) checks.push(r.resolved.city === entry.target.city ? "" : `city→${r.resolved.city ?? "unresolved"}`);
    if (entry.target.speciality !== null) checks.push(r.resolved.speciality === entry.target.speciality ? "" : `spec→${r.resolved.speciality ?? "unresolved"}`);
    const failures = checks.filter((c) => c.length > 0);
    const hasTarget = entry.target.surname !== null || entry.target.city !== null || entry.target.speciality !== null;
    const verdict = !hasTarget ? " ?  " : failures.length === 0 ? "MATCH" : "MISS ";
    if (hasTarget) { if (failures.length === 0) hit += 1; else miss += 1; } else skipped += 1;

    console.log(
      `${verdict} ${S(i + 1, 3)}${S(entry.utterance, 44)} | ${S(`${surname ?? "-"}/${first_name ?? "-"}/${speciality ?? "-"}/${city ?? "-"}`, 40)} | ${S(`${r.resolved.speciality ?? "-"}/${r.resolved.city ?? "-"} unres=[${r.unresolved.join(",")}]`, 34)} | cand=${S(r.candidates, 5)} | ${S(top ? `${top.first_name} ${top.last_name} ${top.score.toFixed(2)}` : "none", 26)} | conf=${r.needs_confirmation ? "Y" : "n"} | q=${S(r.best_question?.attribute ?? "-", 11)} ${failures.join(" ")}`,
    );
  }
  return { hit, miss, skipped };
}

const a = run(data.openings, `OPENINGS (${data.openings.length})`);
const b = run(data.followups, `FOLLOW-UP TURNS (${data.followups.length})`);
console.log(`\nopenings:   ${a.hit} match, ${a.miss} miss, ${a.skipped} no target`);
console.log(`follow-ups: ${b.hit} match, ${b.miss} miss, ${b.skipped} no target`);
console.log(`TOTAL:      ${a.hit + b.hit} match, ${a.miss + b.miss} miss out of ${a.hit + b.hit + a.miss + b.miss} with a target`);
