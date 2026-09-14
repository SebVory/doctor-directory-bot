/**
 * Pure matching helpers — no I/O, no SQLite, no network. Unit-testable in isolation.
 *
 * The problem this solves: a Czech caller says a Romanian surname out loud, a Czech
 * STT writes down what it heard, and we have to find that person in Romanian-spelled
 * data. "Dumitrescu" comes back as "Dumitresku", "Stoica" as "Štojka".
 */

/**
 * Romanian spelling <-> how a Czech ear/STT writes the same sound.
 * Applied to both sides, so the pairs only have to agree with each other.
 * Order matters: earlier rules win on overlapping matches.
 *
 * Diacritics are folded before this table runs, so Czech "č/š/ž/ě" arrive as
 * "c/s/z/e" and Romanian "ș/ț/ă/â/î" as "s/t/a/a/i". That already lines up
 * Romanian "ci/ce" with Czech "či/če", which is why there is no rule for them.
 */
export const TRANSLITERATIONS: ReadonlyArray<readonly [string, string]> = [
  // Romanian c = /k/ before a, o, u and consonants; Czech writes k
  ["ch", "k"],
  ["cu", "ku"],
  ["ca", "ka"],
  ["co", "ko"],
  ["cl", "kl"],
  ["cr", "kr"],
  ["ct", "kt"],
  // Romanian g = /dʒ/ before e, i; Czech writes dž -> dz after folding
  ["ge", "dze"],
  ["gi", "dzi"],
  ["ije", "je"],
  ["ija", "ja"],
  ["ya", "a"],
  // Diphthongs a Czech ear flattens
  ["ea", "a"],
  ["oa", "o"],
  ["oi", "oj"],
  ["ia", "ja"],
  ["ie", "je"],
  ["iu", "ju"],
  // Leftovers from Romanian orthography that Czech STT never produces
  ["ş", "s"],
  ["ţ", "t"],
];

/** lowercase -> fold diacritics -> transliterate -> collapse doubles -> tidy. */
export function normalize(input: string): string {
  let s = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ");

  for (const [from, to] of TRANSLITERATIONS) {
    s = s.replaceAll(from, to);
  }

  return s
    .replace(/(.)\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Czech turns a foreign surname feminine by appending -ová and then declining it.
 * A caller says "doktorka Munteanuová"; the data says "Munteanu".
 *
 * This is surname-only on purpose — folding it into normalize() would eat real
 * Romanian place names ("Craiova" -> "kraj").
 */
export const FEMININE_SUFFIXES: readonly string[] = ["ovou", "ove", "ovy", "ova"];

/** Shortest stem we will accept, so "Popa" never gets chewed down to nothing. */
const MIN_STEM = 3;

/** normalize() plus removal of the Czech feminine suffix. Use for surnames only. */
export function normalizeSurname(input: string): string {
  return normalize(input)
    .split(" ")
    .map((word) => {
      for (const suffix of FEMININE_SUFFIXES) {
        if (word.endsWith(suffix) && word.length - suffix.length >= MIN_STEM) {
          return word.slice(0, -suffix.length);
        }
      }
      return word;
    })
    .join(" ");
}

const FIRST3_BONUS = 0.15;

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

/**
 * Trigram Dice coefficient on normalized strings, in [0, 1], plus a bonus when the
 * first three letters agree — a caller says the start of a surname clearly and
 * trails off at the end, so the head of the string is the more trustworthy part.
 */
export function similarity(a: string, b: string): number {
  return similarityOfNormalized(normalize(a), normalize(b));
}

/**
 * Same metric, for strings that were normalized ahead of time — the store keeps
 * normalized columns so a 7k-row scan does not re-normalize on every query.
 */
export function similarityOfNormalized(na: string, nb: string): number {
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;
  if (na.length < 3 || nb.length < 3) return 0;

  const ta = trigrams(na);
  const tb = trigrams(nb);
  let shared = 0;
  for (const gram of ta) if (tb.has(gram)) shared += 1;

  const dice = (2 * shared) / (ta.size + tb.size);
  const bonus = na.slice(0, 3) === nb.slice(0, 3) ? FIRST3_BONUS : 0;
  return Math.min(1, dice + bonus);
}

/** Czech terms a caller might say -> the exact speciality string stored in the data. */
export const SPECIALITY_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  Cardiology: ["kardiolog", "kardiologie", "kardio", "na srdce", "srdce"],
  Dermatology: ["dermatolog", "dermatologie", "kozni", "kozni lekar", "na kuzi"],
  ENT: ["orl", "usni nosni krcni", "otorinolaryngolog", "krcni", "usni"],
  Endocrinology: ["endokrinolog", "endokrinologie", "na hormony", "stitna zlaza"],
  "Family Medicine": ["prakticky lekar", "praktik", "obvodak", "obvodni lekar", "rodinny lekar"],
  Gastroenterology: ["gastroenterolog", "gastro", "na zaludek", "zazivani"],
  "Infectious Diseases": ["infekcni", "infektolog", "na infekce", "infekce"],
  "Internal Medicine": ["internista", "interna", "vnitrni lekarstvi"],
  Nephrology: ["nefrolog", "nefrologie", "na ledviny", "ledviny"],
  Neurology: ["neurolog", "neurologie", "na nervy"],
  "Obstetrics and Gynecology": ["gynekolog", "gynekologie", "porodnik", "zensky lekar"],
  Oncology: ["onkolog", "onkologie", "na rakovinu", "nadory"],
  Ophthalmology: ["ocni", "ocni lekar", "oftalmolog", "na oci"],
  Orthopedics: ["ortoped", "ortopedie", "na klouby", "kosti"],
  Pediatrics: ["detsky lekar", "pediatr", "pediatrie", "na deti", "detska lekarka"],
  Psychiatry: ["psychiatr", "psychiatrie", "psychiatra"],
  Pulmonology: ["plicni", "plicni lekar", "pneumolog", "na plice"],
  Radiology: ["radiolog", "radiologie", "rentgen", "rtg"],
  Rheumatology: ["revmatolog", "revmatologie", "revma"],
  Urology: ["urolog", "urologie", "mocove cesty"],
};

/** Czech exonyms -> the exact location string stored in the data. */
export const CITY_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  Bucharest: ["bukurest", "bukuresti", "bukurestu", "bucuresti"],
  "Cluj-Napoca": ["kluz", "kluz napoca", "koloszvar", "kolozsvar"],
  Timisoara: ["temesvar", "temeswar", "temesvaru"],
  Iasi: ["jasy", "jas", "jasi"],
  Constanta: ["konstanca", "konstanta", "konstance"],
  Brasov: ["brasov", "kronstadt", "brasove"],
  Sibiu: ["sibin", "hermannstadt", "sibini"],
  Oradea: ["velky varadin", "varadin", "nagyvarad"],
  "Targu Mures": ["targu mures", "marosvasarhely", "novy sekel"],
  Suceava: ["sucava", "sucave"],
  Galati: ["galac", "galace"],
  Craiova: ["krajova", "krajove"],
  Ploiesti: ["plojest", "plojesti"],
  "Alba Iulia": ["alba julie", "gyulafehervar"],
  "Baia Mare": ["baja mare", "nagybanya"],
  "Satu Mare": ["satu mare", "szatmarnemeti"],
  "Sighetu Marmatiei": ["sighet", "siget"],
  "Ramnicu Valcea": ["ramniku valcea", "valcea"],
  "Drobeta-Turnu Severin": ["turnu severin", "severin"],
};

/** Czech language names -> the exact language string stored in the data. */
export const LANGUAGE_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  Romanian: ["rumunsky", "rumunstina", "rumunsky mluvici"],
  English: ["anglicky", "anglictina", "anglicky mluvici"],
  German: ["nemecky", "nemcina"],
  Hungarian: ["madarsky", "madarstina"],
  French: ["francouzsky", "francouzstina"],
  Italian: ["italsky", "italstina"],
  Spanish: ["spanelsky", "spanelstina"],
};

const FUZZY_FLOOR = 0.62;

/**
 * Resolve a spoken term to an exact value present in the data: exact normalized hit
 * on a synonym or on the canonical value itself, else the best fuzzy match above a
 * floor, else null (caller decides whether to ask a clarifying question).
 */
function resolve(
  input: string | undefined,
  table: Readonly<Record<string, readonly string[]>>,
): string | null {
  if (input === undefined || input.trim().length === 0) return null;
  const query = normalize(input);

  for (const [canonical, synonyms] of Object.entries(table)) {
    if (normalize(canonical) === query) return canonical;
    for (const synonym of synonyms) {
      if (normalize(synonym) === query) return canonical;
    }
  }

  let best: string | null = null;
  let bestScore = FUZZY_FLOOR;
  for (const [canonical, synonyms] of Object.entries(table)) {
    for (const candidate of [canonical, ...synonyms]) {
      const score = similarity(query, candidate);
      if (score > bestScore) {
        bestScore = score;
        best = canonical;
      }
    }
  }
  return best;
}

export function resolveSpeciality(input: string | undefined): string | null {
  return resolve(input, SPECIALITY_SYNONYMS);
}

export function resolveLanguage(input: string | undefined): string | null {
  return resolve(input, LANGUAGE_SYNONYMS);
}

/**
 * Cities need the full location list from the data, because most of the 42 towns
 * have no Czech exonym and are only reachable by fuzzy match on their own name.
 */
export function resolveCity(
  input: string | undefined,
  knownLocations: readonly string[],
): string | null {
  if (input === undefined || input.trim().length === 0) return null;

  const table: Record<string, readonly string[]> = {};
  for (const location of knownLocations) {
    table[location] = CITY_SYNONYMS[location] ?? [];
  }
  return resolve(input, table);
}
