import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

// DOCTORS_DB is read when ingest.ts evaluates, so it must be set before the
// dynamic imports below. Vitest gives each test file its own module registry.
const dir = mkdtempSync(join(tmpdir(), "store-test-"));
process.env["DOCTORS_DB"] = join(dir, "doctors.sqlite");

const { DoctorSchema, loadSnapshot } = await import("../src/ingest.js");
const { CONFIRM_THRESHOLD, DOMINANCE_TRIGGER, SUGGESTION_FLOOR, dataAsOf, findDoctors, getDoctorContact } =
  await import("../src/doctor-store.js");
const { normalize, similarityOfNormalized } = await import("../src/match.js");
const { findDoctorsPayload, runTurn } = await import("../src/doctor-agent.js");

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

  it("does not re-confirm a name the caller pronounced correctly", () => {
    // This test used to assert the opposite, and it was wrong. Once the model
    // started passing names through verbatim, the store saw the accusative
    // "Alinu", scored it 0.817 against "Alina", and read back a name the caller
    // had just said — a confirmation step bought by nothing but a case ending.
    const declined = findDoctors({ surname: "Dumitresku", first_name: "Alinu", city: "Kluž" });
    expect(declined.matches[0]?.first_name).toBe("Alina");
    expect(declined.needs_confirmation).toBe(false);
  });

  it("finds short given names that trigrams cannot see through", () => {
    // "Anu" and "Ana" share no trigram at all, so the row used to fall under
    // FIRST_NAME_FLOOR and vanish. Ten Oanas in Oradea came back as "nemám".
    for (const spoken of ["Anu", "Ano", "Any"]) {
      expect(findDoctors({ surname: "Dumitresku", first_name: spoken }).matches[0]?.first_name).toBe("Ana");
    }
    // The transcript case is "Oano z kliniky Oradea Care" — ten Oanas in the
    // full snapshot, none in the 500-row sample, so the city is left out here
    // and the vocative is what is under test.
    const oana = findDoctors({ first_name: "Oano" });
    expect(oana.matches.length).toBeGreaterThan(0);
    expect(oana.matches[0]?.first_name).toBe("Oana");
  });

  it("only considers base forms that are real names here", () => {
    // "Oano" normalises to "ono" — the transliteration flattens the diphthong —
    // and its bare stem "on" scores 0.50 against "Ionut", over the floor. A
    // hypothesis nobody is called cannot identify anyone, so the candidates are
    // filtered against the snapshot before scoring.
    const oana = findDoctors({ first_name: "Oano", limit: 50 });
    expect(oana.matches.length).toBeGreaterThan(0);
    expect(oana.matches.map((m) => m.first_name)).not.toContain("Ionut");
  });

  it("does not widen a given name the data already knows", () => {
    // "Florin" is a name in its own right, so it must not be treated as a
    // declined "Florina" and hand back the wrong person as the top match.
    const florin = findDoctors({ surname: "Dumitrescu", first_name: "Florin" });
    expect(florin.matches[0]?.first_name).toBe("Florin");
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

describe("confirming a misheard name", () => {
  it("holds the id back until the name is confirmed", () => {
    const heard = findDoctors({ surname: "Váselysku", city: "Kluž", speciality: "dětský lékař" });
    expect(heard.needs_confirmation).toBe(true);
    expect(heard.matches[0]?.last_name).toBe("Vasilescu");
  });

  it("lets the caller out of the confirmation loop", () => {
    // Before name_confirmed existed this was a dead end: the model is told to
    // pass names through verbatim, so the search after "jo, to je ona" sent
    // "Váselysku" again and got the same question back, for ever.
    const confirmed = findDoctors({
      surname: "Váselysku",
      city: "Kluž",
      speciality: "dětský lékař",
      name_confirmed: true,
    });
    expect(confirmed.needs_confirmation).toBe(false);
    expect(confirmed.matches[0]?.last_name).toBe("Vasilescu");
  });

  it("re-narrows on the real name instead of picking one of its namesakes", () => {
    // The dangerous shape. "Váselysku" alone scores under the confirm
    // threshold, so nothing is a confident candidate and must_ask would stay
    // false — a confirmation would have released the id of one arbitrary
    // Vasilescu. Confirming the name means searching for the real one.
    const confirmed = findDoctors({ surname: "Váselysku", name_confirmed: true });
    expect(confirmed.needs_confirmation).toBe(false);
    expect(confirmed.candidates).toBeGreaterThan(1);
    expect(confirmed.must_ask).toBe(true);
  });
});

describe("dataAsOf", () => {
  it("reports the snapshot date without running a search", () => {
    expect(dataAsOf()).toBe(findDoctors({ surname: "Popa" }).data_as_of);
  });
});

describe("snapshot date in the system prompt", () => {
  it("is there, so asking how current the data is costs no search", () => {
    // It used to be readable only off the end of a find_doctors result, so
    // "jsou ty údaje aktuální?" ran a filterless scan over every row to fetch
    // one date. Captured from the request rather than asserted on the constant,
    // because the constant is not what gets sent.
    let system = "";
    const recording = {
      messages: {
        create: async (params: { system?: unknown }) => {
          system = JSON.stringify(params.system ?? "");
          return {
            id: "msg", type: "message", role: "assistant", model: "test",
            content: [{ type: "text", text: "Seznam je aktuální." }],
            stop_reason: "end_turn", usage: {},
          };
        },
      },
    };
    return runTurn("Jsou ty údaje aktuální?", [], { trace: false, client: recording as never }).then((result) => {
      expect(system).toContain(dataAsOf());
      expect(result.toolCalls).toHaveLength(0);
    });
  });

  it("follows the snapshot when it is swapped under a running process", async () => {
    // The prompt is cached so it stays byte-identical for prompt caching, and
    // the first version of that cache was built once per process — which is
    // exactly the trap doctor-store re-reads meta on every query to avoid. A
    // bot left running over a nightly ingest would have quoted yesterday.
    const writable = new Database(process.env["DOCTORS_DB"] ?? "");
    try {
      writable.prepare("UPDATE meta SET loaded_at = ? WHERE id = 1").run("2099-01-01T00:00:00.000Z");
    } finally {
      writable.close();
    }

    let system = "";
    const recording = {
      messages: {
        create: async (params: { system?: unknown }) => {
          system = JSON.stringify(params.system ?? "");
          return {
            id: "msg", type: "message", role: "assistant", model: "test",
            content: [{ type: "text", text: "Ano." }],
            stop_reason: "end_turn", usage: {},
          };
        },
      },
    };
    await runTurn("A teď?", [], { trace: false, client: recording as never });
    expect(system).toContain("2099-01-01");
  });
});
