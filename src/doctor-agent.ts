/**
 * Czech-speaking voice directory bot: ask the model, run whatever tools it asked
 * for, feed the results back, repeat.
 */
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { EFFORT, MODEL, makeClient } from "./config.js";
import { type FindResult, dataAsOf, findDoctors, getDoctorContact } from "./doctor-store.js";
import { emergencyReason } from "./emergency.js";

const SYSTEM_RULES = `Jsi telefonní asistent nemocniční sítě v Rumunsku. Mluvíš po telefonu s českým pacientem a hledáš mu lékaře.

Mluv vždy jen česky, včetně první věty, kterou řekneš před hledáním.

Příjmení, křestní jméno a město předávej nástroji doslova tak, jak zazněly v přepisu, včetně chyb a zkomolenin. Nikdy je neopravuj ani nepřekládej — opravu a hledání podobných jmen dělá nástroj, který jediný vidí, jaká jména a města v datech opravdu jsou. Obor a jazyk předávej česky jako dosud.

Jak mluvíš (je to telefon, ne chat):
- Jedna až dvě krátké věty na odpověď. Žádné seznamy, žádné odrážky, žádné markdown, žádné emoji.
- Rumunská jména čti tak, jak se píšou.
- Čísla a adresy diktuj pomalu a po částech.

Jak pracuješ:
- Na dotaz po lékaři vždy zavolej find_doctors. Nikdy si lékaře nevymýšlej — když ho nemáš z nástroje, nemáš ho.
- Přepis řeči komolí slova. Když věta obsahuje něco, co vypadá jako příjmení, a zároveň žádost o ordinační hodiny, kontakt nebo o nalezení lékaře, je to hledání lékaře — i když přepis napsal "restaurace" nebo "hotel" místo "doktorka". Cizojazyčný balast na začátku věty ignoruj.
- Když má odpověď must_ask true, nikdy nejmenuj konkrétního lékaře jako odpověď. Polož otázku z best_question.
- Když má odpověď surname_substituted true, volající řekl příjmení, které v seznamu opravdu existuje, ale nejlepší nález má jiné. Nikdy ho nepodstrkuj jako to hledané. Řekni to rovnou: "Doktora Stan v Vaslui nemám, mám tam doktora Stancu — myslíte jeho?"
- Když volající odpoví na tvou otázku, zavolej find_doctors znovu a předej mu všechno, co už víš — příjmení, křestní jméno, obor i město dohromady.
- Když je v odpovědi unresolved neprázdné, ten pojem v naší síti není. Řekni to rovnou ("Brno v naší síti nemáme") a zeptej se na jiné město nebo obor. Nikdy nepředstírej, že výsledky odpovídají tomu, co volající řekl.
- Když najdeš víc kandidátů, zeptej se přesně na to, co je v best_question: použij jeho attribute a vyjmenuj jeho options. Nikdy se neptej na údaj, který mají všichni kandidáti stejný. Například: "Doktorů Dumitrescu mám víc. V jakém městě ordinuje — v Kluži, v Oradeji, nebo v Galati?" Když je distinct_total větší než počet options, řekni "například", ať volající ví, že jsou i další.
- Při dvou a více kandidátech nikdy žádného z nich nenabízej jako odpověď a nikdy se neptej "to bude on?" nebo "to bude ona?". Vždy polož otázku z best_question. Jméno konkrétního lékaře řekni teprve tehdy, když zbyde jediný kandidát.
- Když má odpověď z find_doctors needs_confirmation true, nejdřív si jméno ověř zpátky, než začneš číst jakékoli údaje: "Slyšel jsem správně, že hledáte doktora Munteanu?"
- Když volající to jméno potvrdí ("jo, to je on", "ano, přesně tak"), zavolej find_doctors znovu se stejnými údaji jako předtím a navíc s name_confirmed true. Jméno pořád předávej doslova tak, jak zaznělo od volajícího — neopravuj ho. Bez name_confirmed dostaneš stejnou otázku znovu a nikam se nedostaneš.
- Když nenajdeš nic, řekni to a zeptej se na specializaci nebo město.
- Telefon, adresu, e-mail a ordinační hodiny říkej jen tehdy, když si o ně volající řekne — tehdy zavolej get_doctor_contact. Sám je nečti. Nabídnout je smíš jednou větou, až když zbyl jediný lékař ("Přejete si kontakt nebo ordinační hodiny?"). Když se o ně volající zeptal hned v první větě a vyšel ti právě jeden lékař, dej mu je rovnou v téhle odpovědi.
- Na "do kolika má" nebo "kdy ordinuje" u jednoho určeného lékaře zavolej get_doctor_contact a přečti availability.
- Když má kontakt email_shared true, řekni, že ta e-mailová adresa patří klinice a sdílí ji víc lékařů stejného jména, a že přímý je telefon.
- Když se best_question ptá na languages, znamená to, že se ti dva záznamy liší jen jazyky a telefonem. Řekni to rovnou ("Mám tam dva se stejným jménem i oborem, liší se jen jazyky") a teprve pak se zeptej.
- Když se volající ptá, jak jsou údaje čerstvé, řekni datum ze seznamu výš. Nevolej kvůli tomu find_doctors.
- Při akutních příznacích (bolest na hrudi, dušnost, silné krvácení, bezvědomí, příznaky mrtvice, čerstvý úraz hlavy) odpověz pouze přesně touto větou: "Volejte okamžitě 155." Nic nevysvětluj, neomlouvej se, nedávej žádnou radu, na nic se neptej a nevolej žádný nástroj. Tohle pravidlo má přednost před pravidlem o radách: i když se volající ptá na postup ("můžu s ním hýbat?"), u akutního stavu platí 155.
- Umíš jen vyhledat lékaře a jeho kontakt. Na příznaky, diagnózu, léky, dávkování nebo objednání termínu odpověz jednou větou, že s tímhle pomoct neumíš, a nabídni, že najdeš lékaře odpovídajícího oboru.`;

const tools: Anthropic.Tool[] = [
  {
    name: "find_doctors",
    description:
      "Najde lékaře v místní kopii nemocničního seznamu. Všechny parametry jsou volitelné — nevyplněné pošli jako null. Příjmení, křestní jméno a město předej doslova tak, jak zazněly v přepisu, včetně zkomolenin; neopravuj je. Obor a jazyk zadávej česky.",
    input_schema: {
      type: "object",
      properties: {
        surname: { type: ["string", "null"], description: "Příjmení doslova tak, jak zaznělo v přepisu. Neopravuj ho." },
        first_name: { type: ["string", "null"], description: "Křestní jméno doslova tak, jak zaznělo. Neopravuj ho." },
        speciality: { type: ["string", "null"], description: "Česky, např. kardiolog, dětský lékař." },
        city: { type: ["string", "null"], description: "Město doslova tak, jak zaznělo v přepisu, i když je zkomolené. Neopravuj ho." },
        language: { type: ["string", "null"], description: "Česky, např. anglicky, maďarsky." },
        name_confirmed: {
          type: ["boolean", "null"],
          description:
            "true jen tehdy, když jsi v předchozím tahu přečetl jméno zpátky a volající ho potvrdil. Jinak null. Zruší opakované ověřování jména; víc kandidátů tím nezmizí.",
        },
      },
      required: ["surname", "first_name", "speciality", "city", "language", "name_confirmed"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "get_doctor_contact",
    description: "Telefon, adresa, e-mail a ordinační hodiny jednoho lékaře. Volej, až když si o některý z těchto údajů volající řekne.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "id z find_doctors" } },
      required: ["id"],
      additionalProperties: false,
    },
    strict: true,
  },
];

/**
 * The rules plus the one fact that changes daily.
 *
 * Built once per process and cached: it goes into the request with
 * cache_control, so it has to be byte-identical between turns. A missing
 * snapshot is not fatal here — the date line is simply left out and the tool
 * call fails later with its own message.
 */
let systemCache: string | null = null;
function systemPrompt(): string {
  if (systemCache !== null) return systemCache;
  let loaded: string | null = null;
  try {
    loaded = dataAsOf();
  } catch {
    loaded = null;
  }
  systemCache =
    loaded === null || loaded === "unknown"
      ? SYSTEM_RULES
      : `${SYSTEM_RULES}\n\nSeznam lékařů je z ${loaded}. Tohle datum řekni, když se volající ptá, jak jsou údaje aktuální.`;
  return systemCache;
}

/** Hard stop on the tool loop — a phone line cannot wait for a runaway agent. */
const MAX_TOOL_TURNS = 6;

/**
 * Dead air is the worst thing that can happen on a call, so every failure path
 * ends in a sentence that tells the caller what to do next.
 */
export const FALLBACK_ANSWER =
  "Omlouvám se, teď to nedokážu dohledat. Zkuste mi prosím říct obor nebo město.";

/**
 * The whole of what an acute caller hears. Not a suggestion to the model: the
 * measured failure was a correctly classified emergency answered in 126
 * characters of explanation, with "155" arriving somewhere in the middle
 * (evals/RUNS.md, the 41/42 run). Deciding *whether* this is an emergency needs
 * context and stays with the model; deciding how long the answer is does not.
 */
export const EMERGENCY_ANSWER = "Volejte okamžitě 155.";

/**
 * A standalone 155 — the dispatch, not a fragment of "+40-243-864-155" or of a
 * street number. Same shape as the evals' emergency pattern, and a test pins
 * the two together.
 */
const EMERGENCY_DISPATCH = /(?<![\d-])155(?![\d-])/;

export type ToolCall = { name: string; input: Record<string, unknown> };
export type TurnResult = {
  /** Only the text of the final call — what the caller is meant to hear as the answer. */
  answer: string;
  /** Milliseconds to the first spoken token on the streamed call, null if none streamed. */
  ttft_ms: number | null;
  /**
   * Filler the model emits alongside a tool call ("Moment, podívám se"). A voice
   * runtime plays this while the search runs, which is where the perceived latency
   * actually goes. It must never be glued onto the answer.
   */
  preamble: string;
  toolCalls: ToolCall[];
  messages: Anthropic.MessageParam[];
};

function nullableString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** One match as the model sees it: `id` only when the contact tool may be used. */
export type VisibleMatch = {
  id?: string;
  first_name: string;
  last_name: string;
  speciality: string;
  city: string;
  clinic_name: string;
  languages: string[];
  score: number;
};

/**
 * What find_doctors sends to the model.
 *
 * The id is a capability, not a label: it is the only thing that makes
 * get_doctor_contact usable, and that tool returns a phone number without
 * knowing whether the identity was ever settled. So while the store says the
 * match is ambiguous (`must_ask`) or unconfirmed (`needs_confirmation`), the id
 * is withheld and the model has nothing to call the contact tool with. A prompt
 * rule asking it not to would leave the capability in its hands; this removes it.
 *
 * Everything else stays, so the model can still ask a good question.
 *
 * Contact details, hours, rating and seniority never appear here at all — they
 * live behind get_doctor_contact, and sending them on every search is tokens the
 * caller waits for and never hears.
 */
export function findDoctorsPayload(result: FindResult): {
  matches: VisibleMatch[];
  candidates: number;
  needs_confirmation: boolean;
  must_ask: boolean;
  surname_substituted: boolean;
  best_question: FindResult["best_question"];
  resolved: FindResult["resolved"];
  unresolved: FindResult["unresolved"];
  data_as_of: string;
} {
  const identityUnsettled = result.must_ask || result.needs_confirmation;

  return {
    matches: result.matches.map((m) => {
      const visible: VisibleMatch = {
        first_name: m.first_name,
        last_name: m.last_name,
        speciality: m.speciality,
        city: m.location,
        clinic_name: m.clinic_name,
        languages: m.languages,
        score: m.score,
      };
      if (!identityUnsettled) visible.id = m.id;
      return visible;
    }),
    candidates: result.candidates,
    needs_confirmation: result.needs_confirmation,
    must_ask: result.must_ask,
    surname_substituted: result.surname_substituted,
    best_question: result.best_question,
    // The model has to know what we understood and what we could not place;
    // without these a term outside the network looks like a plain no-result.
    resolved: result.resolved,
    unresolved: result.unresolved,
    data_as_of: result.data_as_of,
  };
}

/** A missing snapshot is the one failure a reader will hit on a fresh clone. */
function toolErrorMessage(error: unknown): string {
  const text = String(error);
  if (text.includes("unable to open database") || text.includes("fileMustExist") || text.includes("ENOENT")) {
    return "no doctor snapshot yet — run npm run ingest first";
  }
  return text;
}

function executeTool(name: string, input: Record<string, unknown>): string {
  try {
    return runTool(name, input);
  } catch (error) {
    const message = toolErrorMessage(error);
    console.error(`[doctor-agent] tool ${name} failed: ${message}`);
    return JSON.stringify({ error: message });
  }
}

function runTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "find_doctors": {
      const result = findDoctors({
        surname: nullableString(input["surname"]),
        first_name: nullableString(input["first_name"]),
        speciality: nullableString(input["speciality"]),
        city: nullableString(input["city"]),
        language: nullableString(input["language"]),
        name_confirmed: input["name_confirmed"] === true,
      });
      return JSON.stringify(findDoctorsPayload(result));
    }
    case "get_doctor_contact": {
      const id = nullableString(input["id"]);
      const contact = id === undefined ? null : getDoctorContact(id);
      return JSON.stringify(contact ?? { error: "no doctor with that id in this snapshot" });
    }
    default:
      return JSON.stringify({ error: `unknown tool ${name}` });
  }
}

/** Narrow slice of the SDK runTurn needs, so tests can drive the loop without a key. */
/** Minimal stream surface: enough for time-to-first-token, easy to fake in tests. */
type MessageStreamLike = {
  on(event: "text", listener: (delta: string) => void): unknown;
  finalMessage(): Promise<Anthropic.Message>;
};

export type MessagesClient = {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
    /** Optional so a test double can omit it and fall back to create(). */
    stream?(params: Anthropic.MessageCreateParamsNonStreaming): MessageStreamLike;
  };
};

export async function runTurn(
  utterance: string,
  history: Anthropic.MessageParam[] = [],
  options: { trace?: boolean; client?: MessagesClient } = {},
): Promise<TurnResult> {
  // Before anything else — before the client exists, before a prompt is built,
  // before a single token is billed. The recognised emergencies never reach the
  // model, because which of two prompt rules the model picks is not something a
  // bleeding caller should depend on (see src/emergency.ts).
  const reason = emergencyReason(utterance);
  if (reason !== null) {
    console.warn(`[doctor-agent] pre-model emergency dispatch: ${reason}`);
    return {
      answer: EMERGENCY_ANSWER,
      preamble: "",
      ttft_ms: null,
      toolCalls: [],
      messages: [...history, { role: "user", content: utterance }, { role: "assistant", content: EMERGENCY_ANSWER }],
    };
  }

  const trace = options.trace ?? true;
  const client = options.client ?? makeClient();
  const messages: Anthropic.MessageParam[] = [...history, { role: "user", content: utterance }];
  const toolCalls: ToolCall[] = [];
  let firstTokenMs: number | null = null;
  const preambleParts: string[] = [];
  let finalText = "";
  let exhaustedTurns = true;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const callStarted = performance.now();
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: MODEL,
      max_tokens: 2048,
      // Tools then system form a stable prefix on every turn of every call; the
      // breakpoint on system covers both. Volatile content stays in messages.
      system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
      output_config: { effort: EFFORT },
      tools,
      messages,
    };

    // Stream every call after the first tool result: any of them may turn out to
    // be the spoken answer, and time-to-first-token is the number that matters
    // for voice. The opening tool-decision call is never spoken, so it does not.
    let ttftMs: number | null = null;
    let response: Anthropic.Message;

    if (turn > 0 && client.messages.stream !== undefined) {
      const stream = client.messages.stream(params);
      stream.on("text", () => {
        ttftMs ??= Math.round(performance.now() - callStarted);
        firstTokenMs ??= ttftMs;
      });
      response = await stream.finalMessage();
    } else {
      response = await client.messages.create(params);
    }
    const callMs = Math.round(performance.now() - callStarted);

    if (process.env["LOG_TIMING"] === "1") {
      const thinkingBlocks = response.content.filter(
        (b) => b.type === "thinking" || b.type === "redacted_thinking",
      );
      const thinkingChars = thinkingBlocks.reduce(
        (n, b) => n + ((b as { thinking?: string }).thinking ?? "").length,
        0,
      );
      console.error(
        `      [timing] call ${turn + 1}: ${callMs} ms${ttftMs === null ? "" : ` (ttft ${ttftMs} ms)`} · in=${response.usage.input_tokens} out=${response.usage.output_tokens} · thinking=${(response.usage as unknown as { output_tokens_details?: { thinking_tokens?: number } }).output_tokens_details?.thinking_tokens ?? 0} tok`,
      );
    }

    if (process.env["LOG_CACHE"] === "1") {
      const u = response.usage as unknown as Record<string, number | undefined>;
      console.error(`      [cache] write=${u["cache_creation_input_tokens"] ?? 0} read=${u["cache_read_input_tokens"] ?? 0} input=${u["input_tokens"] ?? 0}`);
    }

    if (response.stop_reason === "refusal") {
      console.warn(`[doctor-agent] model declined: ${JSON.stringify(response.stop_details)}`);
      exhaustedTurns = false;
      break;
    }

    // Push the turn before deciding whether to continue, so the final assistant
    // message lands in history exactly once instead of being re-appended as text.
    messages.push({ role: "assistant", content: response.content });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text.trim())
      .filter((t) => t.length > 0)
      .join(" ");

    if (response.stop_reason !== "tool_use") {
      finalText = text;
      exhaustedTurns = false;
      break;
    }

    if (text.length > 0) {
      preambleParts.push(text);
      if (trace) console.log(`   💬 ${text}`);
    }

    const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) {
      const input = use.input as Record<string, unknown>;
      const result = executeTool(use.name, input);
      toolCalls.push({ name: use.name, input });
      if (trace) {
        console.log(`   🔧 ${use.name}(${JSON.stringify(input)})`);
        console.log(`      → ${result.length > 300 ? `${result.slice(0, 300)}…` : result}`);
      }
      results.push({ type: "tool_result", tool_use_id: use.id, content: result });
    }
    messages.push({ role: "user", content: results });
  }

  let answer = finalText.trim();
  let substituted = false;
  if (exhaustedTurns) {
    console.warn(`[doctor-agent] hit MAX_TOOL_TURNS (${MAX_TOOL_TURNS}) — answering with the fallback line`);
    answer = FALLBACK_ANSWER;
    substituted = true;
  } else if (answer.length === 0) {
    console.warn("[doctor-agent] model produced no text — answering with the fallback line");
    answer = FALLBACK_ANSWER;
    substituted = true;
  } else if (toolCalls.length === 0 && EMERGENCY_DISPATCH.test(answer) && answer !== EMERGENCY_ANSWER) {
    // Second layer. The pre-model guard above only knows the phrasings it was
    // given; when the model recognises an emergency this one did not, the caller
    // still hears one line rather than a paragraph with the number somewhere in
    // it. Requiring zero tool calls keeps a read-out address or phone number
    // that happens to contain 155 out of this branch.
    console.warn(`[doctor-agent] emergency answer was ${answer.length} chars — replaced with the fixed line`);
    answer = EMERGENCY_ANSWER;
    // History has to say what the caller actually heard, or the next turn
    // answers a conversation that never happened. The break above guarantees
    // the model's own reply is the last message.
    messages[messages.length - 1] = { role: "assistant", content: answer };
  }

  // Only the substituted line needs adding; real turns are already in history.
  if (substituted) messages.push({ role: "assistant", content: answer });

  return { answer, preamble: preambleParts.join(" "), ttft_ms: firstTokenMs, toolCalls, messages };
}

async function interactive(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let history: Anthropic.MessageParam[] = [];
  console.log("Nemocniční linka — piš česky, prázdný řádek ukončí hovor.\n");

  for (;;) {
    const line = (await rl.question("👤 ")).trim();
    if (line.length === 0) break;
    const result = await runTurn(line, history);
    history = result.messages;
    console.log(`🤖 ${result.answer}\n`);
  }
  rl.close();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const utterance = process.argv.slice(2).join(" ").trim();
  if (utterance.length > 0) {
    console.log(`\n👤 ${utterance}\n`);
    const result = await runTurn(utterance);
    console.log(`\n🤖 ${result.answer}`);
  } else {
    await interactive();
  }
}
