/**
 * Pre-model emergency dispatch. Pure, no I/O, no model, no snapshot.
 *
 * Why this exists rather than a prompt rule. A targeted eval run put
 * "Kamarád upadl. na hlavu a potřebuji vědět, jestli s ním můžu hýbat." through
 * the model and got a 114-character out-of-scope refusal with no 155 in it —
 * the same utterance the full suite had answered correctly minutes earlier. The
 * prompt holds two rules that both fit that sentence ("acute symptoms → 155" and
 * "no medical advice, offer to find a doctor"), and which one wins is a coin
 * toss. A formatting clamp cannot help: it only fires once the model has already
 * decided this is an emergency.
 *
 * So the most dangerous utterances never reach the model at all.
 *
 * This is a dispatcher, not triage. It recognises a short, explicit list of
 * phrasings and says one sentence. Everything it does not recognise goes to the
 * model exactly as before, with the post-model clamp still behind it — the two
 * layers are deliberate, because this list will always be incomplete.
 *
 * The asymmetry that sets the tuning: a false positive tells someone who did not
 * need it to call 155, a false negative leaves someone bleeding on the line
 * talking to a directory. So the patterns lean towards firing — but only on
 * wording that is unambiguous in context, never on a bare keyword. "Hlava",
 * "krvácení" and "mrtvice" appear in ordinary directory queries ("bolesti
 * hlavy", "krvácení z nosu", "měl loni mrtvici"), and every one of those must
 * still reach the search.
 */

/** lowercase + strip diacritics: "dýchá" -> "dycha", so patterns stay ASCII. */
function fold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "");
}

/**
 * Past-tense framing that turns an emergency word into a medical history.
 * "Děda měl loni mrtvici" is a reason to look for a neurologist, not to dial 155.
 */
const PAST = /\bloni\b|\bpred (rokem|lety|mesicem|tydnem)\b|\bv minulosti\b|\bmel[aioy]?\b|\bmela\b|\bprodelal[aioy]?\b/;

/** Any mention of blood or bleeding, in any case ending. */
const BLEEDING = /\bkrvac\w*|\bkrev\b|\bkrvi\b/;

/**
 * The caller is failing to stop the bleeding. The verb has to be there: "nemůžu"
 * on its own is usually about reaching someone, not about a wound.
 *
 * Czech word order is free, so the failure can come before or after the verb,
 * and both directions have to list the same failure words. They did not: the
 * reversed branch was missing "nedaří se" and "nedokážu", so "Nedokážu zastavit
 * krvácení" dispatched and "Krvácení zastavit nedokážu" did not. One shared
 * source string now, because keeping two lists in step by hand is what failed.
 */
// Bare stems, because the reflexive "se" moves: "nedaří se to zastavit" and
// "zastavit se nedaří" are the same sentence with the pronoun on the other side,
// and the gap around the verb already allows it.
const FAILS = /(nejde|nejdou|nemuz\w*|nedari\w*|nedokaz\w*|neda\s+se|neda\b)/.source;
const STOP_FAILURE = new RegExp(
  [
    `\\b${FAILS}\\b[^.?!]{0,30}\\bzastav\\w*`,
    `\\bzastav\\w*[^.?!]{0,20}\\b${FAILS}\\b`,
    "\\bnezastav\\w*",
  ].join("|"),
);

/**
 * The bleeding is what the caller is shopping for, not what is happening.
 *
 * A first attempt vetoed on any search vocabulary in the sentence, which was
 * far too blunt and cost six true emergencies: "Nemůžu se dovolat záchranky,
 * manželka silně krvácí" and "Potřebuji doktora, syn silně krvácí z nohy" both
 * stopped dispatching. In a directory query the bleeding is grammatically
 * attached to the doctor being sought or to a verb of treating it; in an
 * emergency it is a predicate about a person, right now. So the veto has to be
 * local to the bleeding word, never a property of the whole sentence.
 */
const BLEEDING_AS_CONDITION = new RegExp(
  [
    // "doktora na silné krvácení", "specialistu na krvácení"
    /\b(doktor\w*|lekar\w*|specialist\w*|ordinac\w*|klinik\w*)\b[^.?!]{0,30}\bna\b[^.?!]{0,20}krvac\w*/,
    // "která mi léčí krvácení", "co řeší krvácení"
    /\b(leci|lecit|lecil\w*|resi|resit)\b[^.?!]{0,20}krvac\w*/,
    // a standing condition rather than an event
    /\bsklony?\s+ke?\s+krvac\w*/,
    /krvac\w*\s+(dasni|desni|z nosu|pri menstruaci)/,
  ]
    .map((r) => r.source)
    .join("|"),
);

/**
 * Each entry is one recognised emergency, as a caller actually says it.
 *
 * Chest pain must arrive together with breathing trouble; on its own it is left
 * to the model, because "bolest na hrudi" also shows up in "hledám doktora na
 * bolesti na hrudi". Head trauma needs a trauma verb — a fall, a blow, the word
 * "úraz" or "poranění" — never the bare word "hlava". Bleeding needs the caller
 * to be failing to stop it, or to describe it as heavy outside a search framing.
 * Stroke wording needs a present-tense sign.
 */
const PATTERNS: ReadonlyArray<{ readonly label: string; readonly test: (t: string) => boolean }> = [
  {
    label: "chest pain with breathing trouble",
    test: (t) => /bolest\w* na hrudi|bolest\w* na hrudniku|tlak na hrudi/.test(t) && /dych\w*|dusnost|nemuzu se nadechnout|nedostatek vzduchu/.test(t),
  },
  {
    label: "head trauma",
    // "upadl. na hlavu" — the transcript puts a full stop mid-sentence, so the
    // gap between verb and target allows punctuation but stays tiny.
    test: (t) =>
      /\bupad(l|la|li|ly)\b[\s.,!?]{0,4}(na|do)\s+hlav/.test(t) ||
      /\b(uderil|uhodil|prastil|bouchl|kopl)\w*\b[^.?!]{0,20}\bdo hlavy\b/.test(t) ||
      /\buraz hlavy\b|\bporaneni hlavy\b|\brana do hlavy\b|\bspadl\w*\b[\s.,!?]{0,4}(na|do)\s+hlav/.test(t),
  },
  {
    label: "bleeding the caller cannot stop",
    // Two ways in, and both had to be narrowed after they fired on directory
    // queries. "Nemůžu" near "krvácení" is not a symptom — "Nemůžu se dovolat
    // doktorce, co mi léčí krvácení dásní" is a caller who cannot get through —
    // so the failure to stop it has to attach to a stopping verb, not float
    // anywhere in the sentence. And "silné krvácení" is how a caller names the
    // condition they want treated, so it does not count when the bleeding is
    // grammatically the thing being shopped for.
    test: (t) =>
      (BLEEDING.test(t) && STOP_FAILURE.test(t)) ||
      (/\bsilne krvaceni\b|\bsilne krvaci\b|\bhodne krvaci\b|\bzastavit krvaceni\b|\bzastavit krev\b/.test(t) &&
        !BLEEDING_AS_CONDITION.test(t)),
  },
  {
    label: "unconscious or unresponsive",
    test: (t) => /\bv bezvedomi\b|\bupadl\w* do bezvedomi\b|\bomdlel\w*\b[^.?!]{0,20}\bnereaguje\b|\bnereaguje\b[^.?!]{0,20}\bnedycha\b|\bnedycha\b/.test(t),
  },
  {
    label: "stroke signs, happening now",
    // Present-tense signs only, and never when the sentence frames it as history.
    test: (t) =>
      !PAST.test(t) &&
      (/\bpoklesl\w* koutek\b|\bochrnul\w*\b|\bma mrtvici\b|\bdostal\w* mrtvici\b|\bprestal\w* mluvit\b|\bnemuze mluvit\b|\bznecitlivel\w*\b/.test(t)),
  },
];

/**
 * Should this utterance skip the model and get the 155 line?
 *
 * Deliberately says no to, among others: "Děda měl loni mrtvici, hledám
 * neurologa", "Mám objednané vyšetření hlavy", "Hledám doktora na bolesti
 * hlavy", "Hledám doktora, který léčí krvácení z nosu". Numbers are never
 * examined, so "Číslo ordinace končí 155" is an ordinary query too.
 */
export function isEmergencyUtterance(utterance: string): boolean {
  const text = fold(utterance);
  return PATTERNS.some((p) => p.test(text));
}

/** Which rule fired, for logs and for tests that need to say why. */
export function emergencyReason(utterance: string): string | null {
  const text = fold(utterance);
  return PATTERNS.find((p) => p.test(text))?.label ?? null;
}
