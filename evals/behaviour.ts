/**
 * Outcome vocabulary shared by the eval runner and its tests.
 *
 * Patterns run against folded text (lowercase, diacritics stripped), so they are
 * written in ASCII: "nenašel" arrives as "nenasel".
 */

/** lowercase + strip diacritics, so "Kluži" and "kluzi" compare equal. */
export function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "");
}

export type Behaviour =
  | "ask_clarification"
  | "confirm_name"
  | "not_found"
  | "out_of_scope"
  | "emergency";

/** out_of_scope is checked structurally, not by phrasing — see checkCase. */
export const BEHAVIOUR_PATTERNS: Record<Exclude<Behaviour, "out_of_scope">, RegExp> = {
  // Four shapes of "which one do you mean": an interrogative pronoun, a count of
  // candidates, an alternation ending in a question mark (how the bot names
  // best_question's options — "… Alina, Andrei, nebo Cristina?"), or a direct
  // request for a name, which is what it asks when first_name is the question.
  ask_clarification:
    /\b(ktereho|kterou|ktery|kterych|kterem)\b|\bmam (jich )?(dva|dve|tri|ctyri|pet|sest|sedm|osm|devet|deset|jedenact|dvanact|vic)\b|\bnebo\b[^?]*\?|\b(znate|vite|jake|jaky)\b[^?]*(krestni jmeno|jmeno)\b/,
  confirm_name: /\b(slysel|slysela|rozumel|rozumela) jsem spravne\b|\bmyslite (doktora|doktorku|pana|pani)\b/,
  // Czech negation carries the ending, so match the stem plus the endings a bot
  // actually produces: nemám/nemáme, nenašel/nenašla/nenašli, neznám/neznáme,
  // nenacházím. Word order is free, so the "v seznamu není" phrasings are
  // matched in both directions.
  not_found:
    /\bnema(m|me)\b|\bnenas(el|la|li|ly)\b|\bnezna(m|me)\b|\bnenachaz(im|ime)\b|\bnefiguruje\b|\bneni v (seznamu|databazi|nasi siti)\b|\bv (seznamu|databazi|nasi siti) (neni|nikoho|nemam|nemame)\b/,
  // Not a fragment of "+40-243-864-155" — a read-out number is not an emergency.
  emergency: /(?<![\d-])155(?![\d-])/,
};

/** An emergency answer must be one short line, or "155" gets buried. */
export const EMERGENCY_MAX_CHARS = 80;

/**
 * What actually happened on this call, derived from the answer and the tools that
 * ran — not from what the case expected. Same shape a pilot would log per call,
 * so the distribution is comparable between evals and production.
 *
 * Order is precedence: safety first, then the terminal action, then phrasing.
 */
export const OUTCOMES = [
  "emergency",
  "contact",
  "confirm_name",
  "ask_clarification",
  "not_found",
  "out_of_scope",
  "found",
  "other",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export function classify(answer: string, toolCalls: { name: string }[]): Outcome {
  const text = fold(answer);
  const called = (name: string): boolean => toolCalls.some((c) => c.name === name);

  if (BEHAVIOUR_PATTERNS.emergency.test(text)) return "emergency";
  if (called("get_doctor_contact")) return "contact";
  if (BEHAVIOUR_PATTERNS.confirm_name.test(text)) return "confirm_name";
  // not_found before ask_clarification: a not-found answer almost always ends
  // "…obor, nebo město?", which the clarification pattern would otherwise claim,
  // and the outcome breakdown is only useful if it tells those two apart.
  if (BEHAVIOUR_PATTERNS.not_found.test(text)) return "not_found";
  if (BEHAVIOUR_PATTERNS.ask_clarification.test(text)) return "ask_clarification";
  if (toolCalls.length === 0) return "out_of_scope";
  if (called("find_doctors")) return "found";
  return "other";
}

/**
 * avg / max / n over a list of measurements.
 *
 * Pulled out of the runner because the latency numbers were being read with the
 * wrong denominator: the runner timed a whole case, and eleven of the cases are
 * conversations, so its average was per call, not per turn. Now each unit is
 * summarised separately and says how many samples it has.
 */
export function stats(values: readonly number[]): { avg: number; max: number; n: number } {
  if (values.length === 0) return { avg: 0, max: 0, n: 0 };
  const total = values.reduce((sum, value) => sum + value, 0);
  return { avg: Math.round(total / values.length), max: Math.max(...values), n: values.length };
}

/** Genitive month names, as a date is spoken in Czech ("jedenáctého *září*"). */
const CZECH_MONTHS_GENITIVE = [
  "ledna", "unora", "brezna", "dubna", "kvetna", "cervna",
  "cervence", "srpna", "zari", "rijna", "listopadu", "prosince",
];

/** Ordinal stems for days 1–31, folded, so any case ending matches. */
const CZECH_DAY_STEMS = [
  "prvn", "druh", "tret", "ctvrt", "pat", "sest", "sedm", "osm", "devat", "desat",
  "jedenact", "dvanact", "trinact", "ctrnact", "patnact", "sestnact", "sedmnact",
  "osmnact", "devatenact", "dvacat", "dvacat prvn", "dvacat druh", "dvacat tret",
  "dvacat ctvrt", "dvacat pat", "dvacat sest", "dvacat sedm", "dvacat osm",
  "dvacat devat", "tricat", "tricat prvn",
];

/**
 * Does the answer quote this date? Accepts "2026-09-11", "11. 9. 2026" and the
 * form a voice bot actually uses — "jedenáctého září". UTC and local are both
 * allowed so a case does not fail on a late-evening timezone boundary.
 */
export function mentionsDate(answer: string, isoDate: string): boolean {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return false;
  if (answer.includes(isoDate.slice(0, 10))) return true;

  const forms: [number, number, number][] = [
    [date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCFullYear()],
    [date.getDate(), date.getMonth() + 1, date.getFullYear()],
  ];
  // "11. 9. 2026", "11.9.2026" and "k 11. 9." — the year may go unsaid.
  if (forms.some(([d, m]) => new RegExp(`\\b${d}\\.\\s*${m}\\.`).test(answer))) return true;

  const text = fold(answer);
  return forms.some(([d, m]) => {
    const dayStem = CZECH_DAY_STEMS[d - 1];
    const month = CZECH_MONTHS_GENITIVE[m - 1];
    if (dayStem === undefined || month === undefined) return false;
    // Day and month must be adjacent — "jedenáct lékařů … v září" is not a date.
    // Numeric day with a spoken month ("11. září") counts too.
    const spoken = new RegExp(`${dayStem}[a-z]*\\s+${month}`);
    const numeric = new RegExp(`\\b${d}\\.?\\s+${month}`);
    return spoken.test(text) || numeric.test(text);
  });
}

/** Which of these surnames the answer actually names, matched as written. */
export function namesADoctor(answer: string, surnames: readonly string[]): string[] {
  return surnames.filter((surname) => new RegExp(`\\b${surname}\\b`).test(answer));
}

/** What a case can require of a find_doctors result. */
export type FindResultSpec = { last_name?: string; first_name?: string; candidates?: number };

/** Structural shape of a result, so this module stays free of store imports. */
export type FindResultLike = {
  matches: readonly { first_name: string; last_name: string }[];
  candidates: number;
};

/**
 * Does this result satisfy the spec? Checked against the top match, because that
 * is the doctor the bot would name.
 *
 * Asserting on the result rather than on the answer text avoids two traps: Czech
 * declines surnames, so "Vasilescu" never appears literally in "doktora Florina
 * Vasilesca", and a conversation can make several searches, so the last one is
 * not necessarily the one that produced the answer.
 */
export function findResultMatches(result: FindResultLike, spec: FindResultSpec): boolean {
  const top = result.matches[0];
  if (spec.last_name !== undefined && top?.last_name !== spec.last_name) return false;
  if (spec.first_name !== undefined && top?.first_name !== spec.first_name) return false;
  if (spec.candidates !== undefined && result.candidates !== spec.candidates) return false;
  return true;
}
