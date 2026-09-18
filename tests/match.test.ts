import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DoctorSchema, doctorId, findUnreachableValues, loadSnapshot } from "../src/ingest.js";
import {
  CITY_SYNONYMS,
  SPECIALITY_SYNONYMS,
  firstNameVariants,
  normalize,
  normalizeSurname,
  resolveCity,
  resolveLanguage,
  resolveSpeciality,
  similarity,
  similarityOfNormalized,
} from "../src/match.js";

/** Tests run on the committed stratified sample, never the 3 MB snapshot. */
const SAMPLE = "./data/data-sample.json";

type Row = { location: string; speciality: string; languages: string[] };
const rows = JSON.parse(readFileSync(SAMPLE, "utf8")) as Row[];
const LOCATIONS = [...new Set(rows.map((r) => r.location))];
const SPECIALITIES = [...new Set(rows.map((r) => r.speciality))];
const LANGUAGES = [...new Set(rows.flatMap((r) => r.languages))];

/**
 * A surname is "found" when it outranks every other surname in the data. Scored
 * exactly the way doctor-store does it, against the same pre-normalized column.
 */
const SURNAMES = [...new Set(rows.map((r) => (r as unknown as { last_name: string }).last_name))];
function bestSurname(heard: string): string {
  const query = normalizeSurname(heard);
  let best = "";
  let bestScore = -1;
  for (const candidate of SURNAMES) {
    const score = similarityOfNormalized(query, normalizeSurname(candidate));
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

describe("normalize", () => {
  it("folds Czech and Romanian diacritics to ASCII", () => {
    expect(normalize("Štojka")).toBe("stojka");
    expect(normalize("Munteánu")).toBe(normalize("Munteanu"));
    expect(normalize("Timişoara")).toBe(normalize("Timisoara"));
  });

  it("collapses doubled letters", () => {
    expect(normalize("Ionesscu")).toBe(normalize("Ionescu"));
  });

  it("strips punctuation and collapses whitespace", () => {
    // "cl" -> "kl" and "ca" -> "ka" fire here, which is the point: the hyphen and
    // the padding are gone and both sides of a comparison get the same treatment.
    expect(normalize("  Cluj-Napoca  ")).toBe("kluj napoka");
    expect(normalize("Cluj Napoca")).toBe(normalize("cluj-napoca"));
  });

  it("is idempotent", () => {
    expect(normalize(normalize("Dumitrescu"))).toBe(normalize("Dumitrescu"));
  });
});

describe("similarity — STT-mangled Romanian surnames", () => {
  const heard: [string, string][] = [
    ["Dumitresku", "Dumitrescu"],
    ["Munteánu", "Munteanu"],
    ["Vasilesku", "Vasilescu"],
    ["Štojka", "Stoica"],
    ["Popesku", "Popescu"],
    ["Kivu", "Chivu"],
    ["Enake", "Enache"],
    ["Dragomír", "Dragomir"],
    ["Džordžesku", "Georgescu"],
  ];

  it.each(heard)("%s resolves to %s", (spoken, expected) => {
    expect(similarity(spoken, expected)).toBeGreaterThanOrEqual(0.6);
    expect(bestSurname(spoken)).toBe(expected);
  });

  it("scores an exact phonetic hit at 1", () => {
    expect(similarity("Dumitresku", "Dumitrescu")).toBe(1);
    expect(similarity("Štojka", "Stoica")).toBe(1);
  });

  it("is symmetric", () => {
    expect(similarity("Vasilesku", "Vasilescu")).toBe(similarity("Vasilescu", "Vasilesku"));
  });
});

describe("similarity — must NOT match", () => {
  it("rejects an unrelated Czech surname", () => {
    expect(similarity("Novák", "Dumitrescu")).toBeLessThan(0.3);
  });

  it("keeps two different real surnames apart", () => {
    expect(similarity("Popescu", "Ionescu")).toBeLessThan(0.6);
  });

  it("returns 0 for empty input", () => {
    expect(similarity("", "Popescu")).toBe(0);
  });
});

describe("generalisation — surnames the transliteration table was not built on", () => {
  it.each([
    ["Draghomír", "Dragomir"],
    ["Nyagu", "Neagu"],
    ["Ilije", "Ilie"],
    ["Ijakob", "Iacob"],
    ["Rusů", "Rusu"],
    ["Stánová", "Stan"],
  ])("%s resolves to %s", (spoken, expected) => {
    expect(bestSurname(spoken)).toBe(expected);
    expect(similarityOfNormalized(normalizeSurname(spoken), normalizeSurname(expected))).toBeGreaterThanOrEqual(0.6);
  });
});

describe("normalizeSurname — Czech feminine surnames", () => {
  it.each([
    ["Munteanuová", "Munteanu"],
    ["Rusuová", "Rusu"],
    ["Popescuovou", "Popescu"],
    ["Stoicové", "Stoica"],
    ["Iacobová", "Iacob"],
  ])("%s resolves to %s", (spoken, expected) => {
    expect(bestSurname(spoken)).toBe(expected);
  });

  it("resolves every surname in the data in all three declined forms", () => {
    const failures: string[] = [];
    for (const surname of SURNAMES) {
      for (const suffix of ["ová", "ové", "ovou"]) {
        const spoken = `${surname}${suffix}`;
        if (bestSurname(spoken) !== surname) failures.push(`${spoken} -> ${bestSurname(spoken)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("scores the feminine form as confidently as the bare surname", () => {
    // Short surnames used to land near the confirm-the-name threshold; the strip
    // is what keeps the bot from asking "did I hear you right?" unnecessarily.
    expect(similarityOfNormalized(normalizeSurname("Rusuová"), normalizeSurname("Rusu"))).toBe(1);
    expect(similarityOfNormalized(normalizeSurname("Iacobovou"), normalizeSurname("Iacob"))).toBe(1);
  });

  it("leaves a stem shorter than three letters alone", () => {
    expect(normalizeSurname("Popa")).toBe("popa");
    expect(normalizeSurname("Stan")).toBe("stan");
  });

  it("does NOT strip inside plain normalize, so place names survive", () => {
    // "Craiova" is a city in the data — stripping it would break city matching.
    expect(normalize("Craiova").endsWith("ova")).toBe(true);
    expect(resolveCity("Craiova", LOCATIONS)).toBe("Craiova");
  });
});

describe("SPECIALITY_SYNONYMS", () => {
  it("covers every speciality present in data.json", () => {
    const covered = new Set(Object.keys(SPECIALITY_SYNONYMS));
    expect(SPECIALITIES.filter((s) => !covered.has(s))).toEqual([]);
  });

  it("round-trips every speciality value in the data", () => {
    expect(SPECIALITIES.filter((s) => resolveSpeciality(s) !== s)).toEqual([]);
  });

  it.each([
    ["kardiolog", "Cardiology"],
    ["kardiologie", "Cardiology"],
    ["dětský lékař", "Pediatrics"],
    ["pediatr", "Pediatrics"],
    ["gynekolog", "Obstetrics and Gynecology"],
    ["oční", "Ophthalmology"],
    ["neurolog", "Neurology"],
    ["praktický lékař", "Family Medicine"],
    ["obvoďák", "Family Medicine"],
    ["internista", "Internal Medicine"],
    ["psychiatr", "Psychiatry"],
    ["infekční", "Infectious Diseases"],
    ["gastro", "Gastroenterology"],
    ["ušní nosní krční", "ENT"],
  ])("%s -> %s", (spoken, expected) => {
    expect(resolveSpeciality(spoken)).toBe(expected);
  });

  it("returns null for something that is not a speciality", () => {
    expect(resolveSpeciality("kde je nejbližší lékárna")).toBeNull();
  });
});

describe("CITY_SYNONYMS", () => {
  it("only maps onto locations that exist in the data", () => {
    const known = new Set(LOCATIONS);
    expect(Object.keys(CITY_SYNONYMS).filter((c) => !known.has(c))).toEqual([]);
  });

  it("resolves every location in the data to itself", () => {
    expect(LOCATIONS.filter((l) => resolveCity(l, LOCATIONS) !== l)).toEqual([]);
  });

  it.each([
    ["Kluž", "Cluj-Napoca"],
    ["Temešvár", "Timisoara"],
    ["Jasy", "Iasi"],
    ["Bukurešť", "Bucharest"],
    ["Konstanca", "Constanta"],
    ["Brašov", "Brasov"],
    ["Galac", "Galati"],
    ["Ploješť", "Ploiesti"],
  ])("%s -> %s", (spoken, expected) => {
    expect(resolveCity(spoken, LOCATIONS)).toBe(expected);
  });

  it("returns null for a city that is not in the network", () => {
    expect(resolveCity("Ostrava", LOCATIONS)).toBeNull();
  });

  /**
   * DECISIONS §12 claimed no false positive among nine towns outside the
   * network. That was a one-off check nothing held in place, and it does not
   * generalise: over 55 Czech and Slovak place names the 0.55 city floor lets
   * two through. They are listed rather than fixed, because raising the floor
   * would cost the mishearings it was lowered for — so the cost of that
   * threshold is visible here instead of being rediscovered later.
   */
  const OUT_OF_NETWORK = [
    "Praha", "Brno", "Ostrava", "Plzeň", "Liberec", "Olomouc", "Hradec Králové", "Pardubice",
    "Zlín", "Havířov", "Kladno", "Most", "Opava", "Jihlava", "Teplice", "Karlovy Vary",
    "Chomutov", "Děčín", "Frýdek-Místek", "Karviná", "Jablonec nad Nisou", "Mladá Boleslav",
    "Prostějov", "Přerov", "Česká Lípa", "Třebíč", "Třinec", "Tábor", "Znojmo", "Příbram",
    "Cheb", "Trutnov", "Kolín", "Písek", "Kroměříž", "Šumperk", "Vsetín", "Valašské Meziříčí",
    "Litvínov", "Nový Jičín", "Bratislava", "Košice", "Prešov", "Žilina", "Nitra",
    "Banská Bystrica", "Trnava", "Trenčín", "Martin", "Poprad", "Morava", "Slezsko",
    "Sedmihradsko", "Galanta", "Sibiř",
  ];

  it("has exactly two known false positives among 55 Czech and Slovak names", () => {
    const wrong = OUT_OF_NETWORK.map((name) => [name, resolveCity(name, LOCATIONS)] as const).filter(
      ([, resolved]) => resolved !== null,
    );
    expect(wrong).toEqual([
      ["Galanta", "Galati"],
      ["Sibiř", "Sibiu"],
    ]);
  });
});

describe("LANGUAGE_SYNONYMS", () => {
  it("resolves every language in the data to itself", () => {
    expect(LANGUAGES.filter((l) => resolveLanguage(l) !== l)).toEqual([]);
  });

  it.each([
    ["maďarsky", "Hungarian"],
    ["anglicky", "English"],
    ["německy", "German"],
  ])("%s -> %s", (spoken, expected) => {
    expect(resolveLanguage(spoken)).toBe(expected);
  });
});

function fixture(count: number, overrides: Partial<Record<string, unknown>> = {}): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    first_name: `First${i}`,
    last_name: `Last${i}`,
    clinic_name: "Clinica Test",
    location: "Cluj-Napoca",
    speciality: "Cardiology",
    address: `Strada Test ${i}`,
    phone: `+40-000-000-${String(i).padStart(3, "0")}`,
    email: `d${i}@test.ro`,
    postal_code: "500000",
    county: "Cluj",
    years_experience: 5,
    education: "Test University",
    languages: ["Romanian"],
    availability: "Mon-Fri 08:00-16:00",
    rating: 4.2,
    ...overrides,
  }));
}

function rowCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  const n = (db.prepare("SELECT count(*) AS n FROM doctors").get() as { n: number }).n;
  db.close();
  return n;
}

describe("doctorId", () => {
  const doctors = JSON.parse(readFileSync(SAMPLE, "utf8")).map((row: unknown) => DoctorSchema.parse(row));

  it("produces no collisions across the sample", () => {
    const ids = new Map<string, string[]>();
    for (const doctor of doctors) {
      const id = doctorId(doctor);
      ids.set(id, [...(ids.get(id) ?? []), `${doctor.first_name} ${doctor.last_name} · ${doctor.speciality}`]);
    }
    const collisions = [...ids.entries()].filter(([, rows]) => rows.length > 1);
    expect(collisions.map(([id, rows]) => `${id}: ${rows.join(" | ")}`)).toEqual([]);
    expect(ids.size).toBe(doctors.length);
  });

  it("separates two rows that differ only in phone", () => {
    // This is why the id is not last_name|first_name|clinic_name: such rows exist
    // in the real snapshot and carry different contact details.
    const [base] = doctors;
    expect(base).toBeDefined();
    const other = { ...base, phone: `${base.phone}9` };
    expect(doctorId(other)).not.toBe(doctorId(base));
  });

  it("is stable for the same input", () => {
    const [base] = doctors;
    expect(doctorId({ ...base })).toBe(doctorId(base));
  });
});

describe("semantic drift warning", () => {
  it("flags a renamed speciality but still swaps the snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "drift-test-"));
    const dbPath = join(dir, "doctors.sqlite");
    try {
      const drifted = fixture(10, { speciality: "Otorhinolaryngology" });
      const outcome = loadSnapshot(drifted, dbPath);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.unreachable).toContain('speciality "Otorhinolaryngology"');
      expect(rowCount(dbPath)).toBe(10); // warned, not aborted
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports nothing for a snapshot the synonym tables fully cover", () => {
    const clean = fixture(5).map((row) => DoctorSchema.parse(row));
    expect(findUnreachableValues(clean)).toEqual([]);
  });

  it("flags an unknown language", () => {
    const odd = fixture(3, { languages: ["Klingon"] }).map((row) => DoctorSchema.parse(row));
    expect(findUnreachableValues(odd)).toContain('language "Klingon"');
  });
});

describe("ingest robustness", () => {
  it("drops rows that hash to an id already taken instead of aborting", () => {
    const dir = mkdtempSync(join(tmpdir(), "dupe-test-"));
    try {
      const rowsIn = fixture(4);
      const outcome = loadSnapshot([...rowsIn, rowsIn[0], rowsIn[1]], join(dir, "d.sqlite"));
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.duplicates).toBe(2);
      expect(outcome.inserted).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a payload that is not an array", () => {
    const dir = mkdtempSync(join(tmpdir(), "shape-test-"));
    try {
      const outcome = loadSnapshot({ doctors: [] } as unknown as unknown[], join(dir, "d.sqlite"));
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toMatch(/expected a JSON array/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ingest guards", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ingest-test-"));
    dbPath = join(dir, "doctors.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("happy path: loads a clean snapshot and records meta", () => {
    const outcome = loadSnapshot(fixture(10), dbPath);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.inserted).toBe(10);
    expect(outcome.invalid).toBe(0);
    expect(rowCount(dbPath)).toBe(10);

    const db = new Database(dbPath, { readonly: true });
    const meta = db.prepare("SELECT record_count, source_hash FROM meta WHERE id = 1").get() as {
      record_count: number;
      source_hash: string;
    };
    db.close();
    expect(meta.record_count).toBe(10);
    expect(meta.source_hash).toHaveLength(40);
  });

  it("aborts on a count drop and keeps the previous table", () => {
    loadSnapshot(fixture(10), dbPath);
    const outcome = loadSnapshot(fixture(5), dbPath); // 5 < 70% of 10

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toMatch(/below the 70% floor/);
    expect(rowCount(dbPath)).toBe(10);
  });

  it("aborts when too many rows fail validation", () => {
    loadSnapshot(fixture(10), dbPath);
    const broken = [...fixture(8), ...fixture(2, { phone: 42 })]; // 20% invalid > 5% limit
    const outcome = loadSnapshot(broken, dbPath);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.invalid).toBe(2);
    expect(outcome.reason).toMatch(/failed validation/);
    expect(rowCount(dbPath)).toBe(10);
  });

  it("accepts a snapshot that stays within both guards", () => {
    loadSnapshot(fixture(10), dbPath);
    const outcome = loadSnapshot(fixture(8), dbPath); // 8 >= 70% of 10

    expect(outcome.ok).toBe(true);
    expect(rowCount(dbPath)).toBe(8);
  });
});

describe("firstNameVariants", () => {
  it("offers the base form behind a Czech case ending", () => {
    for (const [spoken, base] of [
      ["alinu", "alina"],
      ["alino", "alina"],
      ["aliny", "alina"],
      ["anu", "ana"],
      ["oano", "oana"],
      ["mihaie", "mihai"],
      ["ionu", "ion"],
      ["mariu", "maria"],
    ] as const) {
      expect(firstNameVariants(spoken)).toContain(base);
    }
  });

  it("keeps the caller's own form first, so a correct name is never outranked", () => {
    expect(firstNameVariants("alinu")[0]).toBe("alinu");
    expect(firstNameVariants("ana")[0]).toBe("ana");
  });

  it("offers the bare stem for endings that add a syllable", () => {
    // "Andreje" is one letter from "Andrei" once the ending is gone.
    expect(firstNameVariants("andreje")).toContain("andrej");
  });

  it("leaves a name ending in a consonant alone", () => {
    expect(firstNameVariants("florin")).toEqual(["florin"]);
    expect(firstNameVariants("bogdan")).toEqual(["bogdan"]);
  });

  it("refuses to chew a short name down to nothing", () => {
    // Two letters left would match almost anything, so nothing is offered.
    expect(firstNameVariants("ia")).toEqual(["ia"]);
  });
});
