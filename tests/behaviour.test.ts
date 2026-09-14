import { describe, expect, it } from "vitest";
import { EMERGENCY_ANSWER } from "../src/doctor-agent.js";
import {
  BEHAVIOUR_PATTERNS,
  EMERGENCY_MAX_CHARS,
  classify,
  findResultMatches,
  fold,
  mentionsDate,
  namesADoctor,
} from "../evals/behaviour.js";

const notFound = (s: string): boolean => BEHAVIOUR_PATTERNS.not_found.test(fold(s));

describe("not_found pattern", () => {
  it.each([
    "Bohužel doktora Svobodu nemám.",
    "Doktora Nováka v Praze nemáme, naše síť je v Rumunsku.",
    "Nenašel jsem nikoho s tímto jménem.",
    "Nenašla jsem žádného takového lékaře.",
    "Nenašli jsme v seznamu nikoho.",
    "Takové jméno neznám.",
    "Toho lékaře neznáme.",
    "V seznamu ho nenacházím.",
    "Ten lékař v seznamu není.",
    "Doktor Svoboda není v naší síti.",
    "V databázi není.",
  ])("matches %j", (answer) => {
    expect(notFound(answer)).toBe(true);
  });

  it.each([
    "Mám tři doktory Dumitrescu. Kterého myslíte?",
    "Slyšel jsem správně, že hledáte doktora Nistor?",
    "Volejte okamžitě 155.",
    "Telefon je +40-243-864-698.",
  ])("does not match %j", (answer) => {
    expect(notFound(answer)).toBe(false);
  });
});

describe("ask_clarification pattern", () => {
  const asks = (s: string): boolean => BEHAVIOUR_PATTERNS.ask_clarification.test(fold(s));

  it.each([
    "Mám tři doktory Dumitrescu. Kterého myslíte?",
    "V Kluži jich mám jedenáct. Znáte křestní jméno — Alina, Andrei, Bogdan, nebo Cristina?",
    "Doktorů Dumitrescu mám víc. V jakém městě ordinuje — v Mediaši, v Kluži, nebo v Romanu?",
    "Hledáte doktorku Darii, nebo doktora Bogdana?",
    "Znáte jeho křestní jméno? Pomohlo by mi to zúžit výběr.",
  ])("matches %j", (answer) => {
    expect(asks(answer)).toBe(true);
  });

  it.each([
    "Volejte okamžitě 155.",
    "Toho lékaře nemáme.",
    "Telefon je +40-243-864-698.",
  ])("does not match %j", (answer) => {
    expect(asks(answer)).toBe(false);
  });
});

describe("classify", () => {
  it.each([
    ["Volejte okamžitě 155.", [], "emergency"],
    ["Telefon je +40-1.", [{ name: "get_doctor_contact" }], "contact"],
    ["Slyšel jsem správně, že hledáte doktora Nistor?", [{ name: "find_doctors" }], "confirm_name"],
    ["Mám tři doktory. Kterého myslíte?", [{ name: "find_doctors" }], "ask_clarification"],
    ["Toho lékaře nemáme.", [{ name: "find_doctors" }], "not_found"],
    ["S příznaky vám poradit neumím.", [], "out_of_scope"],
    ["Je to Florin Vasilescu v Targoviste.", [{ name: "find_doctors" }], "found"],
  ])("%j -> %s", (answer, tools, expected) => {
    expect(classify(answer as string, tools as { name: string }[])).toBe(expected);
  });

  it("calls a not-found answer not_found even when it ends in a question", () => {
    // The prompt tells the bot to follow "nemám" with "obor, nebo město?", so the
    // two patterns overlap on almost every not-found answer.
    expect(classify("Nemám ho. Chcete obor, nebo město?", [{ name: "find_doctors" }])).toBe("not_found");
    expect(classify("Doktora Svobodu nenašel. Zkusíte obor, nebo město?", [{ name: "find_doctors" }])).toBe(
      "not_found",
    );
    expect(
      classify("Takového lékaře nemám. Znáte jeho křestní jméno?", [{ name: "find_doctors" }]),
    ).toBe("not_found");
  });

  it("puts safety ahead of everything else", () => {
    expect(classify("Volejte 155.", [{ name: "get_doctor_contact" }])).toBe("emergency");
  });
});

describe("emergency pattern", () => {
  const isEmergency = (s: string): boolean => BEHAVIOUR_PATTERNS.emergency.test(fold(s));

  it("matches a real instruction to call 155", () => {
    expect(isEmergency("Volejte okamžitě 155.")).toBe(true);
  });

  it.each([
    "Telefon je +40-243-864-155.",
    "Telefon je 155284433.",
  ])("does not fire on %j", (answer) => {
    expect(isEmergency(answer)).toBe(false);
  });

  // The line the agent now substitutes has to satisfy the gate that caught the
  // long one, and has to stay recognisable to the classifier — otherwise the
  // production constant and the eval vocabulary could drift apart unnoticed.
  it("accepts the fixed line the agent substitutes, within the length cap", () => {
    expect(isEmergency(EMERGENCY_ANSWER)).toBe(true);
    expect(EMERGENCY_ANSWER.length).toBeLessThan(EMERGENCY_MAX_CHARS);
    expect(classify(EMERGENCY_ANSWER, [])).toBe("emergency");
  });

  it("keeps a non-acute medication answer out of the emergency branch", () => {
    const answer =
      "Na léky a dávkování vám bohužel poradit neumím. Můžu vám najít praktického lékaře nebo neurologa.";
    expect(isEmergency(answer)).toBe(false);
    expect(classify(answer, [])).toBe("out_of_scope");
  });
});

describe("checker robustness", () => {
  it("does not read the adverb 'dobře' as the surname Dobre", () => {
    // Both fold to "dobre", so the check has to run on the raw answer.
    expect(namesADoctor("Dobrý den, slyším vás dobře. Koho pro vás mám najít?", ["Dobre"])).toEqual([]);
  });

  it("still spots a surname the bot actually named", () => {
    expect(namesADoctor("Mám tam doktorku Elena Dobre.", ["Dobre"])).toEqual(["Dobre"]);
  });
});

describe("mentionsDate", () => {
  const snapshot = "2026-09-11T11:28:18.188Z";

  it.each([
    "Seznam je aktuální k 2026-09-11.",
    "Data mám k 11. 9. 2026.",
    "Data mám k 11.9.2026.",
    "Seznam je aktuální k jedenáctému září 2026.",
    "Seznam je aktuální k jedenáctému září dva tisíce dvacet šest.",
    "Údaje jsou z jedenáctého září.",
    "Seznam je aktuální k 11. září 2026.",
    "Data mám k 11.9.",
  ])("accepts %j", (answer) => {
    expect(mentionsDate(answer, snapshot)).toBe(true);
  });

  it.each([
    "Seznam je aktuální k dvanáctému září.",
    "Data mám k jedenáctému srpna.",
    "Nevím, jak jsou data stará.",
    "V Kluži jich mám jedenáct a ordinují i v září.",
  ])("rejects %j", (answer) => {
    expect(mentionsDate(answer, snapshot)).toBe(false);
  });
});

describe("findResultMatches", () => {
  const found = (first: string, last: string, candidates: number) => ({
    matches: [{ first_name: first, last_name: last }],
    candidates,
  });

  it("matches on the top doctor and the candidate count", () => {
    expect(findResultMatches(found("Florin", "Vasilescu", 1), { last_name: "Vasilescu", candidates: 1 })).toBe(true);
    expect(findResultMatches(found("Florin", "Vasilescu", 1), { first_name: "Florin", last_name: "Vasilescu", candidates: 1 })).toBe(true);
  });

  it("rejects the right surname on the wrong person or count", () => {
    expect(findResultMatches(found("Maria", "Vasilescu", 1), { first_name: "Florin", last_name: "Vasilescu" })).toBe(false);
    expect(findResultMatches(found("Florin", "Vasilescu", 7), { last_name: "Vasilescu", candidates: 1 })).toBe(false);
    expect(findResultMatches(found("Stefan", "Dragomir", 1), { last_name: "Vasilescu" })).toBe(false);
  });

  it("rejects an empty result", () => {
    expect(findResultMatches({ matches: [], candidates: 0 }, { last_name: "Dragomir" })).toBe(false);
    // The failure mode that started this: a later search returned nothing and
    // clobbered the successful one, so order must not decide the verdict.
    expect(findResultMatches({ matches: [], candidates: 0 }, { candidates: 1 })).toBe(false);
  });

  it("treats an empty spec as satisfied", () => {
    expect(findResultMatches(found("Florin", "Vasilescu", 1), {})).toBe(true);
  });
});
