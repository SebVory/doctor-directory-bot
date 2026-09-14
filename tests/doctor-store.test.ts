import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// DOCTORS_DB is read when ingest.ts evaluates, so it must be set before the
// dynamic imports below. Vitest gives each test file its own module registry.
const dir = mkdtempSync(join(tmpdir(), "store-test-"));
process.env["DOCTORS_DB"] = join(dir, "doctors.sqlite");

const { DoctorSchema, loadSnapshot } = await import("../src/ingest.js");
const { CONFIRM_THRESHOLD, DOMINANCE_TRIGGER, SUGGESTION_FLOOR, findDoctors, getDoctorContact } =
  await import("../src/doctor-store.js");
const { normalize, similarityOfNormalized } = await import("../src/match.js");
const { findDoctorsPayload } = await import("../src/doctor-agent.js");

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

describe("never confirm a name the search did not find", () => {
  it("returns nothing rather than offering an unrelated surname", () => {
    // A caller who says Popescu was being offered Dumitrescu at 0.31 because no
    // Popescu practised family medicine in that town. That is a different person.
    const result = findDoctors({ surname: "Svoboda" });
    expect(result.matches).toHaveLength(0);
    expect(result.needs_confirmation).toBe(false);
  });

  it("drops Hordyska, which is nobody in the data", () => {
    expect(findDoctors({ surname: "Hordyska" }).matches).toHaveLength(0);
  });

  it("still offers a near miss that is plausibly the same person", () => {
    const result = findDoctors({ surname: "Nyštor" });
    expect(result.matches[0]?.last_name).toBe("Nistor");
    expect(result.matches[0]?.score).toBeGreaterThanOrEqual(SUGGESTION_FLOOR);
    expect(result.needs_confirmation).toBe(true);
  });
});

describe("one confirm threshold, whatever else the caller gave", () => {
  it("a surname alone still has to clear 0.6", () => {
    const bare = findDoctors({ surname: "Váselysku" });
    expect(bare.matches[0]?.last_name).toBe("Vasilescu");
    expect(bare.matches[0]?.score).toBeLessThan(CONFIRM_THRESHOLD);
    expect(bare.needs_confirmation).toBe(true);
  });

  it("still confirms a weak surname even with a speciality and a city", () => {
    const narrowed = findDoctors({ surname: "čivu", speciality: "pediatr", city: "Brasov" });
    expect(narrowed.matches[0]?.last_name).toBe("Chivu");
    expect(narrowed.matches[0]?.score).toBeLessThan(CONFIRM_THRESHOLD);
    expect(narrowed.needs_confirmation).toBe(true);
  });

  it("confirms a surname the transcript shattered", () => {
    // "stane zkus" reaches Stanescu at 0.579. Under the old narrowed bar of 0.45
    // that was read out as fact; it is a fragment, not a name.
    const shattered = findDoctors({ surname: "stane zkus" });
    expect(shattered.matches[0]?.last_name).toBe("Stanescu");
    expect(shattered.matches[0]?.score).toBeLessThan(CONFIRM_THRESHOLD);
    expect(shattered.matches[0]?.score).toBeGreaterThan(0.45); // would have passed the old bar
    expect(shattered.needs_confirmation).toBe(true);
  });

  it("a given name does not lower the bar either", () => {
    const narrowed = findDoctors({ surname: "Moldanová", first_name: "Vlad" });
    expect(narrowed.matches[0]?.last_name).toBe("Moldovan");
    expect(narrowed.needs_confirmation).toBe(true); // 0.55 is under 0.6
  });
});

describe("a given name must not substitute a neighbour", () => {
  it("never hands over Diana as a confident answer when the caller said Ana", () => {
    // 0.500. Kept as a candidate, but the bot has to ask before acting: "Dáryu"
    // against "Daria" scores 0.483, so a floor that drops Diana drops Daria too.
    const result = findDoctors({ surname: "Dumitrescu", first_name: "Ana", city: "Kluž" });
    if (result.matches.some((m) => m.first_name !== "Ana")) {
      expect(result.needs_confirmation).toBe(true);
    }
  });

  it("still narrows on a declined given name", () => {
    // "Alinu" against "Alina" scores 0.817 — a case ending, not a different person.
    const result = findDoctors({ surname: "Dumitresku", first_name: "Alinu", city: "Kluž" });
    expect(result.matches[0]?.first_name).toBe("Alina");
  });

  it("still reaches Daria from the transcript spelling", () => {
    expect(findDoctors({ surname: "Dumitresku", first_name: "Dáryu" }).matches[0]?.first_name).toBe("Daria");
  });

  it("asks when the given name matched only loosely", () => {
    const loose = findDoctors({ surname: "Dumitresku", first_name: "Alinu", city: "Kluž" });
    expect(loose.matches[0]?.first_name).toBe("Alina");
    expect(loose.needs_confirmation).toBe(true); // 0.817 is under FIRST_NAME_CONFIRM
  });
});

describe("a real surname must not be swapped for another one", () => {
  it("flags Stancu offered to someone who said Stan", () => {
    const result = findDoctors({ surname: "Stan", city: "Vaslui", speciality: "onkolog" });
    if (result.matches.length > 0 && result.matches[0]?.last_name !== "Stan") {
      expect(result.surname_substituted).toBe(true);
      expect(result.needs_confirmation).toBe(true);
    }
  });

  it("flags Dumitru offered to someone who said Dumitrescu", () => {
    const result = findDoctors({ surname: "Dumitrescu", city: "Mangalia", speciality: "praktický lékař" });
    if (result.matches.length > 0 && result.matches[0]?.last_name !== "Dumitrescu") {
      expect(result.surname_substituted).toBe(true);
      expect(result.needs_confirmation).toBe(true);
    }
  });

  it("leaves a mishearing alone — čivu is not a surname anyone has", () => {
    const result = findDoctors({ surname: "čivu", speciality: "pediatr", city: "Brasov" });
    expect(result.matches[0]?.last_name).toBe("Chivu");
    expect(result.surname_substituted).toBe(false);
    // It still confirms, because 0.50 is under the single bar — that is item 1.
    expect(result.needs_confirmation).toBe(true);
  });
});

describe("must_ask", () => {
  it("is set when several people remain and a question separates them", () => {
    const many = findDoctors({ surname: "Dumitresku" });
    expect(many.candidates).toBeGreaterThan(1);
    expect(many.must_ask).toBe(true);
  });

  it("is clear once one candidate remains", () => {
    const rowOne = rows[0];
    expect(rowOne).toBeDefined();
    if (rowOne === undefined) return;
    const one = findDoctors({
      surname: rowOne.last_name, first_name: rowOne.first_name,
      city: rowOne.location, speciality: rowOne.speciality,
    });
    if (one.candidates === 1) expect(one.must_ask).toBe(false);
  });

  it("is clear when nothing was found", () => {
    expect(findDoctors({ surname: "Svoboda" }).must_ask).toBe(false);
  });
});

describe("the contact id is a capability, not a label", () => {
  /**
   * get_doctor_contact returns a phone number for any valid id and cannot know
   * whether the identity was settled. So the id must not reach the model while
   * the store still says the match is ambiguous or unconfirmed — otherwise the
   * only thing standing between a caller and a stranger's direct line is a
   * sentence in the prompt.
   */
  it("withholds every id while the search is ambiguous", () => {
    const ambiguous = findDoctors({ surname: "Dumitresku" });
    expect(ambiguous.must_ask).toBe(true);
    expect(ambiguous.matches.length).toBeGreaterThan(1);
    // The store still knows the ids; the model does not get them.
    expect(ambiguous.matches.every((m) => m.id.length > 0)).toBe(true);

    const payload = findDoctorsPayload(ambiguous);
    expect(payload.matches.length).toBe(ambiguous.matches.length);
    expect(payload.matches.some((m) => m.id !== undefined)).toBe(false);
  });

  it("withholds every id while the name is unconfirmed", () => {
    const unsure = findDoctors({ surname: "Nyštor" });
    expect(unsure.needs_confirmation).toBe(true);
    expect(findDoctorsPayload(unsure).matches.some((m) => m.id !== undefined)).toBe(false);
  });

  it("releases the id once exactly one confident match remains", () => {
    const row = rows[0];
    if (row === undefined) throw new Error("sample has no rows");
    const resolved = findDoctors({
      surname: row.last_name, first_name: row.first_name,
      city: row.location, speciality: row.speciality,
    });
    if (resolved.candidates !== 1 || resolved.needs_confirmation || resolved.must_ask) return;

    const payload = findDoctorsPayload(resolved);
    expect(payload.matches[0]?.id).toBe(resolved.matches[0]?.id);
  });

  it("still gives the model everything it needs to ask a good question", () => {
    const payload = findDoctorsPayload(findDoctors({ surname: "Dumitresku" }));
    const first = payload.matches[0];
    expect(first?.first_name).toBeTruthy();
    expect(first?.last_name).toBeTruthy();
    expect(first?.city).toBeTruthy();
    expect(payload.best_question).not.toBeNull();
    expect(payload.candidates).toBeGreaterThan(1);
  });

  it("never leaks contact details through the search payload", () => {
    const payload = findDoctorsPayload(findDoctors({ surname: "Dumitresku" }));
    const serialised = JSON.stringify(payload);
    for (const field of ["phone", "address", "email", "availability"]) {
      expect(serialised).not.toContain(field);
    }
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
    if (pair === undefined) throw new Error("sample carries no irreducible pair — make-sample must pin one");

    const [first] = pair;
    if (first === undefined) throw new Error("empty group");
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
