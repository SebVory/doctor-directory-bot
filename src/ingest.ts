/**
 * Snapshot ingest: pull the whole doctor list once, validate it, and swap it into
 * SQLite atomically. Nothing reads the hospital during a call — this is the only
 * thing that ever talks to them, and it is safe to run from cron.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { z } from "zod";
import { fetchJson } from "./api-client.js";
import { normalize, resolveLanguage, resolveSpeciality } from "./match.js";

const SOURCE_URL = process.env.HOSPITAL_URL ?? "http://localhost:4010/doctors";
export const DB_PATH = process.env.DOCTORS_DB ?? "./db/doctors.sqlite";

/** Abort rather than publish a snapshot that lost rows or arrived malformed. */
export const MIN_RETAINED_FRACTION = 0.7;
export const MAX_INVALID_FRACTION = 0.05;

export const DoctorSchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  clinic_name: z.string().min(1),
  location: z.string().min(1),
  speciality: z.string().min(1),
  address: z.string(),
  phone: z.string().min(1),
  email: z.string(),
  postal_code: z.string(),
  county: z.string(),
  years_experience: z.number().int().nonnegative(),
  education: z.string(),
  languages: z.array(z.string()),
  availability: z.string(),
  rating: z.number(),
});
export type Doctor = z.infer<typeof DoctorSchema>;

/**
 * Stable id for one row within one snapshot.
 *
 * last_name|first_name|clinic_name alone collides on 669 of the 7029 rows, and the
 * colliding rows carry *different* phone numbers and addresses — so speciality and
 * phone are folded in to keep get_doctor_contact from reading out a wrong number.
 */
export function doctorId(row: Doctor): string {
  return createHash("sha1")
    .update([row.last_name, row.first_name, row.clinic_name, row.speciality, row.phone].join("|"))
    .digest("hex");
}

const CREATE_TABLE = `
CREATE TABLE doctors_new (
  id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  clinic_name TEXT NOT NULL,
  location TEXT NOT NULL,
  speciality TEXT NOT NULL,
  address TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  county TEXT NOT NULL,
  years_experience INTEGER NOT NULL,
  education TEXT NOT NULL,
  languages_json TEXT NOT NULL,
  availability TEXT NOT NULL,
  rating REAL NOT NULL,
  last_name_norm TEXT NOT NULL,
  first_name_norm TEXT NOT NULL,
  city_norm TEXT NOT NULL,
  speciality_norm TEXT NOT NULL
)`;

const CREATE_INDEXES = `
CREATE INDEX idx_doctors_speciality ON doctors(speciality_norm);
CREATE INDEX idx_doctors_city ON doctors(city_norm);
CREATE INDEX idx_doctors_surname ON doctors(last_name_norm);
CREATE UNIQUE INDEX idx_doctors_id ON doctors(id);
`;

/**
 * A snapshot can stay schema-valid while drifting semantically — a speciality
 * renamed upstream still parses, but no Czech synonym reaches it any more and
 * the bot silently returns nothing for that term. Warn, never abort: the data
 * is not wrong, our tables are behind.
 */
export function findUnreachableValues(rows: readonly Doctor[]): string[] {
  const unreachable: string[] = [];

  for (const speciality of new Set(rows.map((r) => r.speciality))) {
    if (resolveSpeciality(speciality) !== speciality) unreachable.push(`speciality "${speciality}"`);
  }
  for (const language of new Set(rows.flatMap((r) => r.languages))) {
    if (resolveLanguage(language) !== language) unreachable.push(`language "${language}"`);
  }
  return unreachable;
}

export type IngestOutcome =
  | {
      ok: true;
      inserted: number;
      invalid: number;
      /** Rows dropped because another row produced the same id. */
      duplicates: number;
      previousCount: number;
      sourceHash: string;
      /** Values with no Czech synonym — a warning, not a failure. */
      unreachable: string[];
    }
  | { ok: false; reason: string; inserted: number; invalid: number; previousCount: number };

function openDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), loaded_at TEXT NOT NULL, record_count INTEGER NOT NULL, source_hash TEXT NOT NULL)",
  );
  return db;
}

function previousRecordCount(db: Database.Database): number {
  const row = db.prepare("SELECT record_count FROM meta WHERE id = 1").get() as
    | { record_count: number }
    | undefined;
  return row?.record_count ?? 0;
}

/**
 * Validate, stage, guard, then swap. The old `doctors` table stays live and intact
 * until the very last transaction, so a bad snapshot costs freshness, not service.
 */
export function loadSnapshot(raw: readonly unknown[], dbPath: string): IngestOutcome {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      inserted: 0,
      invalid: 0,
      previousCount: 0,
      reason: `expected a JSON array of doctors, got ${raw === null ? "null" : typeof raw}`,
    };
  }

  const db = openDb(dbPath);
  try {
    const previousCount = previousRecordCount(db);

    const valid: Doctor[] = [];
    const problems: string[] = [];
    for (const [index, row] of raw.entries()) {
      const parsed = DoctorSchema.safeParse(row);
      if (parsed.success) {
        valid.push(parsed.data);
      } else if (problems.length < 5) {
        problems.push(`row ${index}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      }
    }
    const invalid = raw.length - valid.length;
    const invalidFraction = raw.length === 0 ? 1 : invalid / raw.length;

    if (invalidFraction > MAX_INVALID_FRACTION) {
      return {
        ok: false,
        inserted: 0,
        invalid,
        previousCount,
        reason: `${(invalidFraction * 100).toFixed(1)}% of rows failed validation (limit ${MAX_INVALID_FRACTION * 100}%) — ${problems.join("; ")}`,
      };
    }

    db.exec("DROP TABLE IF EXISTS doctors_new");
    db.exec(CREATE_TABLE);

    const insert = db.prepare(`
      INSERT INTO doctors_new VALUES (
        @id, @first_name, @last_name, @clinic_name, @location, @speciality, @address,
        @phone, @email, @postal_code, @county, @years_experience, @education,
        @languages_json, @availability, @rating,
        @last_name_norm, @first_name_norm, @city_norm, @speciality_norm)`);

    // Two rows can hash to the same id if every field in the hash matches. Drop
    // the repeat rather than letting the unique index abort a whole snapshot.
    const seen = new Set<string>();
    const unique: Doctor[] = [];
    let duplicates = 0;
    for (const row of valid) {
      const id = doctorId(row);
      if (seen.has(id)) duplicates += 1;
      else {
        seen.add(id);
        unique.push(row);
      }
    }

    db.transaction((rows: readonly Doctor[]) => {
      for (const row of rows) {
        insert.run({
          ...row,
          id: doctorId(row),
          languages_json: JSON.stringify(row.languages),
          last_name_norm: normalize(row.last_name),
          first_name_norm: normalize(row.first_name),
          city_norm: normalize(row.location),
          speciality_norm: normalize(row.speciality),
        });
      }
    })(unique);

    const inserted = (db.prepare("SELECT count(*) AS n FROM doctors_new").get() as { n: number }).n;

    if (previousCount > 0 && inserted < previousCount * MIN_RETAINED_FRACTION) {
      db.exec("DROP TABLE doctors_new");
      return {
        ok: false,
        inserted,
        invalid,
        previousCount,
        reason: `snapshot has ${inserted} rows vs ${previousCount} previously (below the ${MIN_RETAINED_FRACTION * 100}% floor) — keeping the old table`,
      };
    }

    const unreachable = findUnreachableValues(valid);
    if (unreachable.length > 0) {
      console.warn(
        `[ingest] WARNING: ${unreachable.length} value(s) have no Czech synonym and are unreachable by voice — ${unreachable.join(", ")}`,
      );
    }

    const sourceHash = createHash("sha1").update(JSON.stringify(valid)).digest("hex");

    db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS doctors");
      db.exec("ALTER TABLE doctors_new RENAME TO doctors");
      db.exec(CREATE_INDEXES);
      db.prepare(
        "INSERT INTO meta (id, loaded_at, record_count, source_hash) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET loaded_at = excluded.loaded_at, record_count = excluded.record_count, source_hash = excluded.source_hash",
      ).run(new Date().toISOString(), inserted, sourceHash);
    })();

    return { ok: true, inserted, invalid, duplicates, previousCount, sourceHash, unreachable };
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  console.log(`[ingest] fetching ${SOURCE_URL} (this endpoint is slow by design)`);
  const started = Date.now();
  const raw = await fetchJson<unknown[]>(SOURCE_URL, { attempts: 2, timeoutMs: 900_000 });
  const fetchSeconds = ((Date.now() - started) / 1000).toFixed(1);

  const outcome = loadSnapshot(raw, DB_PATH);
  if (!outcome.ok) {
    console.error(`[ingest] ABORTED after ${fetchSeconds}s — ${outcome.reason}`);
    process.exit(1);
  }
  console.log(
    `[ingest] ok — ${outcome.inserted} doctors in ${DB_PATH} (was ${outcome.previousCount}, ${outcome.invalid} invalid, ${outcome.duplicates} duplicate, fetched in ${fetchSeconds}s, hash ${outcome.sourceHash.slice(0, 8)})`,
  );
}
