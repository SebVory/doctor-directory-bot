/**
 * Read side. Everything here runs against the local snapshot — never the hospital.
 */
import Database from "better-sqlite3";
import { DB_PATH } from "./ingest.js";
import { firstNameVariants, normalize, normalizeSurname, resolveCity, resolveLanguage, resolveSpeciality, similarityOfNormalized } from "./match.js";

/**
 * Below this surname confidence the bot reads the name back before giving out
 * details. It lives here, not in the prompt, so it can be unit-tested and tuned
 * without touching Czech prose.
 *
 * One bar, whatever else the caller gave. A lower bar for queries narrowed by a
 * speciality or a city was tried and withdrawn: it was calibrated while the model
 * still repaired surnames before the tool saw them, so scores arrived near 1.0.
 * With the transcript passed through verbatim, "stane zkus" reaches Stanescu at
 * 0.579 and would have been read out as fact.
 */
export const CONFIRM_THRESHOLD = 0.6;

/**
 * Below this, a candidate is not a worse guess — it is a different person. The
 * bot must never read a name back that the search did not really find: a caller
 * who said Popescu was being offered Dumitrescu at 0.31.
 */
export const SUGGESTION_FLOOR = 0.4;

/**
 * A wide net is right while the matcher is unsure — "Nyštor" should still reach
 * "Nistor" at 0.5. It is wrong once something matches almost exactly: with 277
 * spot-on Dumitrescus in hand, 288 Dumitrus at 0.765 are noise, and they corrupt
 * both the shortlist and the disambiguating question.
 */
export const DOMINANCE_TRIGGER = 0.95;
export const DOMINANCE_FLOOR = 0.85;

/** Below this a given name is noise rather than a mishearing. */
export const FIRST_NAME_FLOOR = 0.45;

/**
 * Above the floor but below this, the name matched loosely and the bot reads it
 * back instead of acting on it.
 *
 * The floor cannot do this work alone: "Dáryu" against "Daria" scores 0.483 and
 * must be kept, while "Ana" against "Diana" scores 0.500 and must not be acted
 * on. The wrong one scores higher, so no threshold separates them — what
 * separates them is asking.
 */
export const FIRST_NAME_CONFIRM = 0.85;

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
// clinic_name is deliberately absent: in this data the 42 clinics are a
// bijection with the 42 cities ("Clinica {city} Care"), so asking which clinic
// asks which city in words no caller would use. It stays in the tool payload
// because the bot still says it out loud once one doctor remains.
const QUESTION_ATTRIBUTES = ["city", "speciality", "first_name", "languages"] as const;
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

export function bestQuestion(
  candidates: readonly CandidateAttributes[],
  surnameWasGiven = true,
): BestQuestion | null {
  if (candidates.length < 2) return null;

  // Surname comes first and sits outside the bucket metric — but only when the
  // caller actually said one. "Dumitrescu, or Dumitru?" resolves a mishearing;
  // asked of someone who only named a town it is a question they cannot answer.
  const surnames = new Map<string, number>();
  for (const candidate of candidates) {
    surnames.set(candidate.last_name, (surnames.get(candidate.last_name) ?? 0) + 1);
  }
  if (surnameWasGiven && surnames.size > 1) {
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
  /**
   * The caller has just confirmed the name that was read back to them.
   *
   * Without this the confirmation step has no exit. The model is told to pass
   * names through verbatim, so the second search after "jo, to je on" sends the
   * same mangled surname, scores it the same way, and gets needs_confirmation
   * back again — with the id still withheld. The loop only ended when the model
   * broke the verbatim rule and typed the corrected name.
   *
   * It clears the name doubt and nothing else: several candidates still have to
   * be narrowed, because agreeing to a surname does not say which of the ten
   * people carrying it the caller wants.
   */
  name_confirmed?: boolean;
};

export type FindResult = {
  matches: DoctorMatch[];
  /** How many people the caller might plausibly mean, after scoring and dominance. */
  candidates: number;
  /** True when a surname was given but the best hit is under the confirm threshold. */
  needs_confirmation: boolean;
  /** More than one plausible person and a question that separates them: do not name one. */
  must_ask: boolean;
  /** The caller said a real surname and the best hit carries a different one. */
  surname_substituted: boolean;
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
  /**
   * The e-mail is derived from name + clinic, so two different doctors who share
   * both share an inbox — 616 pairs in the full snapshot. Reading it out as
   * personal would send the caller to the wrong person; the phone is unique.
   */
  email_shared: boolean;
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

type Store = {
  db: Database.Database;
  locations: string[];
  /** Every surname in the snapshot, normalized, so we can tell a real name from a mishearing. */
  surnames: Set<string>;
  /** Same for given names, so a name the data knows is never widened into another. */
  firstNames: Set<string>;
  dataAsOf: string;
};

let cached: Store | null = null;

function store(): Store {
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
    const surnames = new Set(
      (db.prepare("SELECT DISTINCT last_name_norm FROM doctors").all() as { last_name_norm: string }[])
        .map((r) => r.last_name_norm),
    );
    const firstNames = new Set(
      (db.prepare("SELECT DISTINCT first_name_norm FROM doctors").all() as { first_name_norm: string }[])
        .map((r) => r.first_name_norm),
    );
    cached = { db, locations, surnames, firstNames, dataAsOf: loadedAt };
  }
  return cached;
}

export function findDoctors(query: FindQuery): FindResult {
  const { db, locations, surnames: knownSurnames, firstNames: knownFirstNames, dataAsOf } = store();
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
      must_ask: false,
      surname_substituted: false,
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

  // A given name the data already knows is taken at its word. Anything else may
  // be a Czech case ending, so it is scored against the base forms it could have
  // come from — but only those that are real names here. A hypothesis nobody in
  // the snapshot is called cannot identify anyone, and loose ones do damage:
  // "Oano" normalises to "ono", whose bare stem let three Ionuts into the
  // candidates for Oana at 0.50 and pushed the count from 10 to 14.
  const firstCandidates =
    firstNorm === null
      ? null
      : knownFirstNames.has(firstNorm)
        ? [firstNorm]
        : [firstNorm, ...firstNameVariants(firstNorm).filter((v) => v !== firstNorm && knownFirstNames.has(v))];

  // 7029 rows carry 26 distinct surnames and 30 given names between them, so
  // scoring per row rebuilt the same trigram sets thousands of times: 7029 calls
  // cost 9.1 ms, the 26 distinct ones cost 0.66 ms. Memoising on the normalized
  // column value took a surname-only search from 7.6-8.3 ms to 4.2-4.6 ms (p50,
  // 300 runs) and paid for the extra given-name candidates several times over.
  // The remaining 3.4 ms is the unfiltered SELECT, which is a separate problem.
  const surnameScores = new Map<string, number>();
  /** Surname similarity for one normalized column value, computed once. */
  const scoreSurname = (norm: string): number => {
    if (surnameNorm === null) return 1;
    const seen = surnameScores.get(norm);
    if (seen !== undefined) return seen;
    const value = similarityOfNormalized(surnameNorm, norm);
    surnameScores.set(norm, value);
    return value;
  };

  const firstScores = new Map<string, number>();
  /** Best given-name similarity across every candidate base form, computed once. */
  const scoreFirst = (norm: string): number => {
    if (firstCandidates === null) return 1;
    const seen = firstScores.get(norm);
    if (seen !== undefined) return seen;
    let best = 0;
    for (const candidate of firstCandidates) {
      const value = similarityOfNormalized(candidate, norm);
      if (value > best) best = value;
    }
    firstScores.set(norm, best);
    return best;
  };

  let scored = rows.flatMap((row) => {
    const score = scoreSurname(row.last_name_norm);
    const firstScore = scoreFirst(row.first_name_norm);
    if (firstNorm !== null && firstScore < FIRST_NAME_FLOOR) return [];
    return [{ row, score, firstScore }];
  });

  // An exact hit on a name the data knows wins outright, if there is one.
  //
  // Ten pairs of distinct given names here clear the 0.45 floor – Ana pulls in
  // Diana at 0.500, Maria pulls Daria at 0.667, Oana pulls Ioana – so a search
  // for a name the snapshot knows was counting other people as candidates and
  // could ask a narrowing question that exists only because of them. None of
  // those pairs reaches 0.85, so a wrong name was never asserted as fact, but
  // the count was wrong and the question after it was noise.
  //
  // This applies to the declension candidates too, not only to a name the
  // caller happened to say in the nominative: "Anu" resolves to Ana, and the
  // Dianas it also reaches are the same noise by a longer route.
  //
  // Only when an exact row survives, which is the point. Where nothing matches
  // exactly the near miss is the most useful thing the store has: "Maria" from
  // an STT that heard Daria should reach Daria and be read back, not turn into
  // "nemám".
  if (firstCandidates !== null) {
    const exactForms = new Set(firstCandidates.filter((c) => knownFirstNames.has(c)));
    if (exactForms.size > 0) {
      const exact = scored.filter((entry) => exactForms.has(entry.row.first_name_norm));
      if (exact.length > 0) scored = exact;
    }
  }

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
  // there are and will name one. Below the threshold the best guess is offered
  // for confirmation, but only if it is close enough to be the same person.
  const confident = plausibleScored.filter((entry) => entry.score >= CONFIRM_THRESHOLD);
  const shortlist =
    confident.length > 0
      ? confident
      : plausibleScored.filter((entry) => entry.score >= SUGGESTION_FLOOR);

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

  // Computed over every confident candidate, not just the handful read out —
  // 277 Dumitrescus need "which city", even though only three are returned.
  const plausible = confident.map(({ row }) => ({
    last_name: row.last_name,
    location: row.location,
    speciality: row.speciality,
    first_name: row.first_name,
    languages: JSON.parse(row.languages_json) as string[],
  }));
  const question = bestQuestion(plausible, surnameNorm !== null);

  const top = matches[0];
  const topEntry = shortlist[0];

  // Three independent reasons to read the name back before acting on it.
  const surnameUnsure =
    surnameNorm !== null && top !== undefined && top.score < CONFIRM_THRESHOLD;
  const firstNameUnsure =
    firstNorm !== null && topEntry !== undefined && topEntry.firstScore < FIRST_NAME_CONFIRM;
  const surname_substituted =
    surnameNorm !== null &&
    knownSurnames.has(surnameNorm) &&
    topEntry !== undefined &&
    topEntry.row.last_name_norm !== surnameNorm;

  // A confirmed name is no longer the caller's approximation of it — it is the
  // name on the row that was read back. Clearing the flag alone would be worse
  // than the deadlock it fixes: "Váselysku" scores under the confirm threshold,
  // so nothing counts as a confident candidate, must_ask stays false, and the
  // turn would hand out the id of one arbitrary Vasilescu out of 270. So the
  // heard name is replaced by the real one and the search runs again, which is
  // what the caller actually agreed to. The second pass matches exactly, so it
  // raises no doubt of its own and cannot recurse further.
  if (query.name_confirmed === true && topEntry !== undefined) {
    const surnameDiffers = surnameNorm !== null && topEntry.row.last_name_norm !== surnameNorm;
    const firstDiffers = firstNorm !== null && topEntry.row.first_name_norm !== firstNorm;
    if (surnameDiffers || firstDiffers) {
      const { name_confirmed: _confirmed, ...rest } = query;
      return findDoctors({
        ...rest,
        ...(surnameNorm === null ? {} : { surname: topEntry.row.last_name }),
        ...(firstNorm === null ? {} : { first_name: topEntry.row.first_name }),
      });
    }
  }

  const needs_confirmation =
    query.name_confirmed !== true && (surnameUnsure || firstNameUnsure || surname_substituted);


  return {
    matches,
    candidates: plausible.length,
    needs_confirmation,
    best_question: question,
    must_ask: plausible.length > 1 && question !== null,
    surname_substituted,
    resolved,
    unresolved,
    data_as_of: dataAsOf,
  };
}

/**
 * When the snapshot was loaded, without running a search.
 *
 * "Jsou ty údaje aktuální?" used to be answerable only out of a find_doctors
 * result, so the bot ran a filterless scan over 7029 rows to read one date off
 * the end of it. The date belongs in the system prompt instead.
 */
export function dataAsOf(): string {
  return store().dataAsOf;
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

  const sharing = db.prepare("SELECT count(*) AS n FROM doctors WHERE email = ?").get(row.email) as {
    n: number;
  };

  const { first_name, last_name, ...rest } = row;
  return { ...rest, full_name: `${first_name} ${last_name}`, email_shared: sharing.n > 1 };
}
