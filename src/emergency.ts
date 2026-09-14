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

/**
 * Each entry is one recognised emergency, as a caller actually says it.
 *
 * Chest pain must arrive together with breathing trouble; on its own it is left
 * to the model, because "bolest na hrudi" also shows up in "hledám doktora na
 * bolesti na hrudi". Head trauma needs a trauma verb — a fall, a blow, the word
 * "úraz" or "poranění" — never the bare word "hlava". Bleeding needs the caller
 * to be trying to stop it. Stroke wording needs a present-tense sign.
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
    test: (t) =>
      /\bsilne krvaceni\b|\bsilne krvaci\b|\bhodne krvaci\b|\bzastavit krvaceni\b|\bzastavit krev\b/.test(t) ||
      (/\bkrvac\w*/.test(t) && /\bnejde\b|\bnemuzu\b|\bneda se\b|\bnezastav\w*/.test(t)),
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
