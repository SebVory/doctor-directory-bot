import { describe, expect, it } from "vitest";
import { BEHAVIOUR_PATTERNS, classify, fold } from "../evals/behaviour.js";

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
  });

  it("puts safety ahead of everything else", () => {
    expect(classify("Volejte 155.", [{ name: "get_doctor_contact" }])).toBe("emergency");
  });
});
