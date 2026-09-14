import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// DOCTORS_DB is read when ingest.ts evaluates, so it must be set before the
// dynamic imports below. Vitest gives each test file its own module registry.
const dir = mkdtempSync(join(tmpdir(), "store-test-"));
process.env["DOCTORS_DB"] = join(dir, "doctors.sqlite");

const { DoctorSchema, loadSnapshot } = await import("../src/ingest.js");
const { CONFIRM_THRESHOLD, DOMINANCE_TRIGGER, findDoctors, getDoctorContact } = await import(
  "../src/doctor-store.js"
);
const { normalize, similarityOfNormalized } = await import("../src/match.js");

const rows = (JSON.parse(readFileSync("./data/data-sample.json", "utf8")) as unknown[]).map((r) =>
  DoctorSchema.parse(r),
);
const outcome = loadSnapshot(rows, process.env["DOCTORS_DB"] ?? "");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("unresolved terms", () => {
  it("returns nothing for a city outside the network instead of ignoring the filter", () => {
    const result = findDoctors({ speciality: "kardiolog", city: "Brně" });

    expect(result.unresolved).toEqual(["city"]);
    expect(result.matches).toHaveLength(0);
    expect(result.candidates).toBe(0);
    expect(result.best_question).toBeNull();
    expect(result.resolved.speciality).toBe("Cardiology");
  });

  it("flags a speciality that is not in the data", () => {
    const result = findDoctors({ speciality: "zubař" });
    expect(result.unresolved).toEqual(["speciality"]);
    expect(result.matches).toHaveLength(0);
  });

  it("reports nothing unresolved when every term lands", () => {
    const [row] = rows;
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(findDoctors({ speciality: row.speciality, city: row.location }).unresolved).toEqual([]);
  });
});

describe("first name scoring", () => {
  it("does not drag an exact surname under the dominance trigger", () => {
    const withFirst = findDoctors({ surname: "Dumitresku", first_name: "Alinu" });
    // Surname alone decides: an exact surname hit still scores 1.
    expect(withFirst.matches[0]?.score).toBe(1);
    expect(withFirst.matches.every((m) => m.last_name === "Dumitrescu")).toBe(true);
  });

  it("re-ranks by given name without changing the candidate set", () => {
    const plain = findDoctors({ surname: "Dumitresku" });
    const alina = findDoctors({ surname: "Dumitresku", first_name: "Alinu" });
    expect(alina.matches[0]?.first_name).toMatch(/^Alin/);
    expect(alina.candidates).toBeLessThanOrEqual(plain.candidates);
  });

  it("excludes a candidate whose given name is plainly different", () => {
    const result = findDoctors({ surname: "Dumitresku", first_name: "Alinu" });
    const floorBreached = result.matches.some(
      (m) => similarityOfNormalized(normalize("Alinu"), normalize(m.first_name)) < 0.4,
    );
    expect(floorBreached).toBe(false);
  });
});

describe("shortlist consistency", () => {
  /**
   * The bug this guards: matches was sliced straight off the scored rows, while
   * candidates and best_question counted only rows at or above the threshold. A
   * narrow prefilter left one confident hit plus unrelated surnames far below it,
   * and the model was told "1 candidate, no confirmation needed" while holding a
   * list it could read the wrong name from.
   */
  function narrowSpot(surname: string): { location: string; speciality: string } | null {
    const groups = new Map<string, number>();
    for (const row of rows) {
      if (row.last_name !== surname) continue;
      const key = `${row.location}|${row.speciality}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    for (const [key, n] of groups) {
      if (n !== 1) continue;
      const [location, speciality] = key.split("|");
      if (location !== undefined && speciality !== undefined) return { location, speciality };
    }
    return null;
  }

  it("never ships a below-threshold name once something clears the threshold", () => {
    // "Džordžesku" lands on Georgescu around 0.75: past the confirm threshold,
    // short of the dominance trigger — exactly the window that leaked.
    const spot = narrowSpot("Georgescu");
    expect(spot).not.toBeNull();
    if (spot === null) return;

    const result = findDoctors({ surname: "Džordžesku", ...spot });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.last_name).toBe("Georgescu");
    expect(result.matches.filter((m) => m.score < CONFIRM_THRESHOLD)).toEqual([]);
    expect(result.matches).toHaveLength(result.candidates);
  });

  it("keeps matches and candidates in step across query shapes", () => {
    const queries = [
      { surname: "Dumitresku" },
      { surname: "Džordžesku" },
      { surname: "Dumitresku", speciality: "psychiatr" },
      { speciality: "kardiolog" },
    ];
    for (const query of queries) {
      const result = findDoctors(query);
      if (result.candidates === 0) continue; // the confirm path, asserted below
      expect(result.matches.filter((m) => m.score < CONFIRM_THRESHOLD)).toEqual([]);
      expect(result.matches.length).toBeLessThanOrEqual(result.candidates);
    }
  });

  it("still returns the best guess when nothing clears the threshold", () => {
    // Otherwise the bot has no name to read back and cannot confirm.
    const result = findDoctors({ surname: "Nyštor" });
    expect(result.candidates).toBe(0);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.last_name).toBe("Nistor");
    expect(result.needs_confirmation).toBe(true);
  });
});

describe("exact-match dominance", () => {
  it("drops the near-miss surnames once something matches almost exactly", () => {
    // "Dumitresku" also pulls "Dumitru" in at ~0.77. With exact Dumitrescu hits
    // present, only Dumitrescu should remain plausible.
    const expected = rows.filter((r) => r.last_name === "Dumitrescu").length;
    const result = findDoctors({ surname: "Dumitresku" });

    expect(expected).toBeGreaterThan(0);
    expect(result.candidates).toBe(expected);
    expect(result.matches.every((m) => m.last_name === "Dumitrescu")).toBe(true);
  });

  it("keeps the wide net when nothing matches almost exactly", () => {
    const result = findDoctors({ surname: "Nyštor" });

    expect(result.matches[0]?.last_name).toBe("Nistor");
    expect(result.matches[0]?.score).toBeLessThan(DOMINANCE_TRIGGER);
    expect(result.needs_confirmation).toBe(true);
    // Nothing clears the confirm threshold, so there is no confident candidate to
    // disambiguate between — the bot verifies the name instead of asking a question.
    expect(result.candidates).toBe(0);
    expect(result.best_question).toBeNull();
  });

  it("still finds nothing for a surname that is not there", () => {
    const result = findDoctors({ surname: "Svoboda" });
    expect(result.matches).toHaveLength(0);
    expect(result.candidates).toBe(0);
  });
});

describe("findDoctors", () => {
  it("loaded the sample into a temp database", () => {
    expect(outcome.ok).toBe(true);
  });

  it("does not ask for confirmation on a confident surname hit", () => {
    const result = findDoctors({ surname: "Dumitresku" });
    expect(result.matches[0]?.score).toBeGreaterThanOrEqual(CONFIRM_THRESHOLD);
    expect(result.needs_confirmation).toBe(false);
  });

  it("asks for confirmation when the best hit is under the threshold", () => {
    const result = findDoctors({ surname: "Nyštor" });
    expect(result.matches[0]?.last_name).toBe("Nistor");
    expect(result.matches[0]?.score).toBeLessThan(CONFIRM_THRESHOLD);
    expect(result.needs_confirmation).toBe(true);
  });

  it("resolves Nyagu to Neagu outright — it was a missing table row, not uncertainty", () => {
    const result = findDoctors({ surname: "Nyagu" });
    expect(result.matches[0]?.last_name).toBe("Neagu");
    expect(result.matches[0]?.score).toBe(1);
    expect(result.needs_confirmation).toBe(false);
  });

  it("asks for confirmation for a second mangling in the band", () => {
    const result = findDoctors({ surname: "Nyštor" });
    expect(result.matches[0]?.last_name).toBe("Nistor");
    expect(result.needs_confirmation).toBe(true);
  });

  it("never asks for confirmation when no surname was given", () => {
    // Taken from the sample so the pair is guaranteed to exist; the canonical
    // English values round-trip through the synonym tables.
    const [row] = rows;
    expect(row).toBeDefined();
    if (row === undefined) return;
    const result = findDoctors({ speciality: row.speciality, city: row.location });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.needs_confirmation).toBe(false);
  });

  it("does not ask for confirmation when there is nothing to confirm", () => {
    const result = findDoctors({ surname: "Svoboda" });
    expect(result.matches).toHaveLength(0);
    expect(result.needs_confirmation).toBe(false);
  });

  it("resolves Czech specialities and city exonyms", () => {
    const result = findDoctors({ speciality: "dětský lékař", city: "Temešvár" });
    expect(result.resolved).toEqual({ speciality: "Pediatrics", city: "Timisoara", language: null });
  });

  it("returns contact details only for a known id", () => {
    const [first] = findDoctors({ surname: "Dumitresku" }).matches;
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(getDoctorContact(first.id)?.phone).toMatch(/^\+40-/);
    expect(getDoctorContact("nope")).toBeNull();
  });
});

describe("shared e-mail addresses", () => {
  /** Two doctors with the same name at the same clinic derive the same address. */
  function sharedEmailPair(): { email: string; ids: string[] } | null {
    const byEmail = new Map<string, string[]>();
    for (const row of rows) {
      const key = row.email;
      byEmail.set(key, [...(byEmail.get(key) ?? []), `${row.first_name} ${row.last_name}`]);
    }
    for (const [email, who] of byEmail) if (who.length > 1) return { email, ids: who };
    return null;
  }

  it("flags an e-mail that more than one doctor answers", () => {
    const pair = sharedEmailPair();
    expect(pair).not.toBeNull();
    if (pair === null) return;

    // Find the matching rows through the store and check both report the flag.
    const [name] = pair.ids;
    const surname = name?.split(" ")[1] ?? "";
    const found = findDoctors({ surname, limit: 50 }).matches.filter((m) =>
      getDoctorContact(m.id)?.email === pair.email,
    );
    expect(found.length).toBeGreaterThan(0);
    for (const match of found) {
      const contact = getDoctorContact(match.id);
      expect(contact?.email_shared).toBe(true);
      expect(contact?.phone).toMatch(/^\+40-/);
    }
  });

  it("does not flag an e-mail only one doctor answers", () => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.email, (counts.get(row.email) ?? 0) + 1);
    const soleEmail = [...counts.entries()].find(([, n]) => n === 1)?.[0];
    expect(soleEmail).toBeDefined();

    const row = rows.find((r) => r.email === soleEmail);
    expect(row).toBeDefined();
    if (row === undefined) return;
    const match = findDoctors({ surname: row.last_name, first_name: row.first_name, limit: 50 }).matches.find(
      (m) => getDoctorContact(m.id)?.email === soleEmail,
    );
    expect(match).toBeDefined();
    if (match === undefined) return;
    expect(getDoctorContact(match.id)?.email_shared).toBe(false);
  });
});

describe("irreducible pairs", () => {
  it("falls back to languages when name, city and speciality all match", () => {
    // 30 such pairs in the full snapshot: same person-name, same town, same
    // speciality, differing only in phone, address, languages and rating.
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = [row.first_name, row.last_name, row.location, row.speciality].join("|");
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const pair = [...groups.values()].find((g) => g.length > 1);
    if (pair === undefined) return; // the 500-row sample may not carry one

    const [first] = pair;
    if (first === undefined) return;
    const result = findDoctors({
      surname: first.last_name,
      first_name: first.first_name,
      city: first.location,
      speciality: first.speciality,
    });
    expect(result.best_question?.attribute).toBe("languages");
  });
});

describe("snapshot cache", () => {
  it("follows a re-ingest inside the same process", () => {
    const dbPath = process.env["DOCTORS_DB"] ?? "";
    const before = findDoctors({ surname: "Dumitresku" });

    // A second ingest in the same process: a long-running agent must not keep
    // quoting the old data_as_of after the nightly swap.
    const second = loadSnapshot(rows.slice(0, Math.floor(rows.length * 0.9)), dbPath);
    expect(second.ok).toBe(true);

    const after = findDoctors({ surname: "Dumitresku" });
    expect(after.data_as_of).not.toBe(before.data_as_of);
    expect(after.candidates).toBeLessThanOrEqual(before.candidates);
  });
});
