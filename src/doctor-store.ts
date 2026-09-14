/**
 * Read side. Everything here runs against the local snapshot — never the hospital.
 */
import Database from "better-sqlite3";
import { DB_PATH } from "./ingest.js";
import { normalize, normalizeSurname, resolveCity, resolveLanguage, resolveSpeciality, similarityOfNormalized } from "./match.js";

/**
 * Below this surname confidence the bot reads the name back before giving out
 * details. It lives here, not in the prompt, so it can be unit-tested and tuned
 * without touching Czech prose.
 */
export const CONFIRM_THRESHOLD = 0.6;

/**
 * A wide net is right while the matcher is unsure — "Nyštor" should still reach
 * "Nistor" at 0.5. It is wrong once something matches almost exactly: with 277
 * spot-on Dumitrescus in hand, 288 Dumitrus at 0.765 are noise, and they corrupt
 * both the shortlist and the disambiguating question.
 */
export const DOMINANCE_TRIGGER = 0.95;
export const DOMINANCE_FLOOR = 0.85;

/** A given name this far off is a mismatch, not a weak signal — drop the row. */
export const FIRST_NAME_FLOOR = 0.4;

export type DoctorMatch = {
  id: string;
  first_name: string;
  last_name: string;
  clinic_name: string;
  location: string;
  speciality: string;
  languages: string[];
  availability: string;
  years_experience: number;
  rating: number;
  /** Surname confidence in [0, 1]; 1 when no surname was given to score against. */
  score: number;
};

/** Attributes the bot can disambiguate on, in tie-break order. */
const QUESTION_ATTRIBUTES = ["city", "speciality", "clinic_name", "first_name", "languages"] as const;
export type QuestionAttribute = (typeof QUESTION_ATTRIBUTES)[number] | "last_name";

export type BestQuestion = {
  attribute: QuestionAttribute;
  options: { value: string; count: number }[];
  /** How many distinct values exist; options lists at most four of them. */
  distinct_total: number;
};

/** The fields disambiguation looks at; kept minimal so it is testable without a DB. */
export type CandidateAttributes = {
  last_name: string;
  location: string;
  speciality: string;
  clinic_name: string;
  first_name: string;
  languages: string[];
};

function valuesOf(attribute: QuestionAttribute, candidate: CandidateAttributes): string[] {
  switch (attribute) {
    case "last_name":
      return [candidate.last_name];
    case "city":
      return [candidate.location];
    case "speciality":
      return [candidate.speciality];
    case "clinic_name":
      return [candidate.clinic_name];
    case "first_name":
      return [candidate.first_name];
    case "languages":
      return candidate.languages;
  }
}

/**
 * Which single question splits these candidates best.
 *
 * For each attribute, the largest bucket is how many candidates would survive the
 * worst answer. Smallest such bucket wins, so one question removes the most
 * people. Attributes every candidate shares are useless and are skipped — asking
 * "which city?" when all of them sit in the same city wastes a turn.
 */
function rank(counts: Map<string, number>): { value: string; count: number }[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, count }));
}

export function bestQuestion(candidates: readonly CandidateAttributes[]): BestQuestion | null {
  if (candidates.length < 2) return null;

  // Surname comes first and sits outside the bucket metric. "Dumitrescu, nebo
  // Dumitru?" is always the right first question, and the smallest-largest-bucket
  // rule would hand it to city (42 values) every time.
  const surnames = new Map<string, number>();
  for (const candidate of candidates) {
    surnames.set(candidate.last_name, (surnames.get(candidate.last_name) ?? 0) + 1);
  }
  if (surnames.size > 1) {
    return { attribute: "last_name", options: rank(surnames).slice(0, 4), distinct_total: surnames.size };
  }

  let best: (BestQuestion & { largest: number; distinct: number }) | null = null;

  for (const attribute of QUESTION_ATTRIBUTES) {
    const counts = new Map<string, number>();
    for (const candidate of candidates) {
      for (const value of valuesOf(attribute, candidate)) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    if (counts.size < 2) continue;

    const ranked = rank(counts);
    const largest = ranked[0]?.count ?? 0;
    const distinct = counts.size;

    // Smallest worst-case bucket wins. Ties go to QUESTION_ATTRIBUTES order, so a
    // receptionist's question ("Daria, nebo Bogdan?") beats an odd one about
    // languages when both split the field equally well.
    if (best === null || largest < best.largest) {
      best = { attribute, largest, distinct, options: ranked.slice(0, 4), distinct_total: distinct };
    }
  }

  return best === null
    ? null
    : { attribute: best.attribute, options: best.options, distinct_total: best.distinct_total };
}

export type FindQuery = {
  surname?: string;
  /** Given name, as heard. Scored the same fuzzy way as the surname. */
  first_name?: string;
  speciality?: string;
  city?: string;
  language?: string;
  limit?: number;
};

export type FindResult = {
  matches: DoctorMatch[];
  /** How many people the caller might plausibly mean, after scoring and dominance. */
  candidates: number;
  /** True when a surname was given but the best hit is under CONFIRM_THRESHOLD. */
  needs_confirmation: boolean;
  /** The single most useful question to split the plausible candidates; null when there is one. */
  best_question: BestQuestion | null;
  /** What the spoken terms were understood as — null means "not recognised". */
  resolved: { speciality: string | null; city: string | null; language: string | null };
  /** Terms the caller gave that are not in this network at all. */
  unresolved: ("speciality" | "city" | "language")[];
  data_as_of: string;
};

export type DoctorContact = {
  id: string;
  full_name: string;
  clinic_name: string;
  phone: string;
  address: string;
  email: string;
  location: string;
  availability: string;
};

type Row = {
  id: string;
  first_name: string;
  last_name: string;
  clinic_name: string;
  location: string;
  speciality: string;
  languages_json: string;
  availability: string;
  years_experience: number;
  rating: number;
  last_name_norm: string;
  first_name_norm: string;
};

let cached: { db: Database.Database; locations: string[]; dataAsOf: string } | null = null;

function store(): { db: Database.Database; locations: string[]; dataAsOf: string } {
  const db = cached?.db ?? new Database(DB_PATH, { readonly: true, fileMustExist: true });

  // Cheap on every call, and the only thing standing between a long-running agent
  // and quoting yesterday's data_as_of after the nightly ingest swapped the table.
  const meta = db.prepare("SELECT loaded_at FROM meta WHERE id = 1").get() as
    | { loaded_at: string }
    | undefined;
  const loadedAt = meta?.loaded_at ?? "unknown";

  if (cached === null || cached.dataAsOf !== loadedAt) {
    const locations = (db.prepare("SELECT DISTINCT location FROM doctors").all() as { location: string }[])
      .map((r) => r.location);
    cached = { db, locations, dataAsOf: loadedAt };
  }
  return cached;
}

export function findDoctors(query: FindQuery): FindResult {
  const { db, locations, dataAsOf } = store();
  const limit = query.limit ?? 3;

  const speciality = resolveSpeciality(query.speciality);
  const city = resolveCity(query.city, locations);
  const language = resolveLanguage(query.language);
  const resolved = { speciality, city, language };

  const given = (value: string | undefined): boolean => value !== undefined && value.trim().length > 0;
  const unresolved: FindResult["unresolved"] = [];
  if (given(query.speciality) && speciality === null) unresolved.push("speciality");
  if (given(query.city) && city === null) unresolved.push("city");
  if (given(query.language) && language === null) unresolved.push("language");

  // A term we could not place must never be silently dropped from the filter —
  // "kardiolog v Brně" would otherwise return three cardiologists in Romania.
  if (unresolved.length > 0) {
    return {
      matches: [],
      candidates: 0,
      needs_confirmation: false,
      best_question: null,
      resolved,
      unresolved,
      data_as_of: dataAsOf,
    };
  }

  const where: string[] = [];
  const params: string[] = [];
  if (speciality !== null) {
    where.push("speciality_norm = ?");
    params.push(normalize(speciality));
  }
  if (city !== null) {
    where.push("city_norm = ?");
    params.push(normalize(city));
  }
  if (language !== null) {
    where.push("languages_json LIKE ?");
    params.push(`%"${language}"%`);
  }

  const sql = `SELECT id, first_name, last_name, clinic_name, location, speciality,
    languages_json, availability, years_experience, rating, last_name_norm, first_name_norm
    FROM doctors${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const rows = db.prepare(sql).all(...params) as Row[];

  // The surname alone decides confidence, dominance and plausibility. A given
  // name only re-ranks within that set and removes outright mismatches — averaging
  // the two would drag an exact surname under the dominance trigger.
  const surnameNorm = query.surname === undefined ? null : normalizeSurname(query.surname);
  const firstNorm = query.first_name === undefined ? null : normalize(query.first_name);

  const scored = rows.flatMap((row) => {
    const score = surnameNorm === null ? 1 : similarityOfNormalized(surnameNorm, row.last_name_norm);
    const firstScore = firstNorm === null ? 1 : similarityOfNormalized(firstNorm, row.first_name_norm);
    if (firstNorm !== null && firstScore < FIRST_NAME_FLOOR) return [];
    return [{ row, score, firstScore }];
  });

  // With a surname, confidence decides. Without one, the best-rated doctor is the
  // most useful thing to read out first.
  scored.sort(
    (a, b) => b.score - a.score || b.firstScore - a.firstScore || b.row.rating - a.row.rating,
  );

  const hasNearExact = scored.some((entry) => entry.score >= DOMINANCE_TRIGGER);
  const plausibleScored = scored.filter((entry) =>
    hasNearExact ? entry.score >= DOMINANCE_FLOOR : entry.score > 0,
  );

  // Once anything clears the confirm threshold, weaker rows are noise rather than
  // alternatives and must not reach the model — it is told how many candidates
  // there are and will name one. Below the threshold the best guess is all we
  // have, and the bot reads the name back instead of acting on it.
  const confident = plausibleScored.filter((entry) => entry.score >= CONFIRM_THRESHOLD);
  const shortlist = confident.length > 0 ? confident : plausibleScored;

  const matches = shortlist
    .slice(0, limit)
    .map(({ row, score }) => ({
      id: row.id,
      first_name: row.first_name,
      last_name: row.last_name,
      clinic_name: row.clinic_name,
      location: row.location,
      speciality: row.speciality,
      languages: JSON.parse(row.languages_json) as string[],
      availability: row.availability,
      years_experience: row.years_experience,
      rating: row.rating,
      score: Number(score.toFixed(3)),
    }));

  const top = matches[0];
  const needs_confirmation =
    surnameNorm !== null && top !== undefined && top.score < CONFIRM_THRESHOLD;

  // Computed over every plausible candidate, not just the handful we read out —
  // 277 Dumitrescus need "which city", even though only three are returned.
  const plausible = confident.map(({ row }) => ({
      last_name: row.last_name,
      location: row.location,
      speciality: row.speciality,
      clinic_name: row.clinic_name,
      first_name: row.first_name,
      languages: JSON.parse(row.languages_json) as string[],
    }));

  return {
    matches,
    candidates: plausible.length,
    needs_confirmation,
    best_question: bestQuestion(plausible),
    resolved,
    unresolved,
    data_as_of: dataAsOf,
  };
}

export function getDoctorContact(id: string): DoctorContact | null {
  const { db } = store();
  const row = db
    .prepare(
      "SELECT id, first_name, last_name, clinic_name, phone, address, email, location, availability FROM doctors WHERE id = ?",
    )
    .get(id) as
    | (Omit<DoctorContact, "full_name"> & { first_name: string; last_name: string })
    | undefined;

  if (row === undefined) return null;
  const { first_name, last_name, ...rest } = row;
  return { ...rest, full_name: `${first_name} ${last_name}` };
}
