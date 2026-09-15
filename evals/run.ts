/**
 * Behavioural regression gate. Every case runs one real turn through the agent and
 * checks what it *did* (tool calls) as well as what it said.
 */
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { FALLBACK_ANSWER, runTurn } from "../src/doctor-agent.js";
import { DB_PATH } from "../src/ingest.js";
import { findDoctors } from "../src/doctor-store.js";

/** Tool arguments arrive as string | null; the store wants string | undefined. */
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v : undefined);
import {
  BEHAVIOUR_PATTERNS,
  type FindResultSpec,
  findResultMatches,
  mentionsDate,
  namesADoctor,
  type Behaviour,
  EMERGENCY_MAX_CHARS,
  OUTCOMES,
  type Outcome,
  classify,
  fold,
  stats,
} from "./behaviour.js";

/** Read once from the same snapshot the agent answers from. */
const snapshot = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const DATA_AS_OF =
  (snapshot.prepare("SELECT loaded_at FROM meta WHERE id = 1").get() as { loaded_at: string } | undefined)
    ?.loaded_at ?? "";
const SURNAMES = (snapshot.prepare("SELECT DISTINCT last_name FROM doctors").all() as { last_name: string }[])
  .map((r) => r.last_name);
snapshot.close();

type Case = {
  /** A single-turn case. Mutually exclusive with `turns`. */
  utterance?: string;
  /** A conversation. Assertions apply to the last turn only. */
  turns?: string[];
  /** Free text for whoever writes the case; ignored by the checks. */
  note?: string;
  expect: {
    tool?: string;
    /** Tool that must NOT be called — e.g. contact details before they were asked for. */
    tool_not_called?: string;
    /** A tool that must be called on one specific turn (1-indexed), not just somewhere. */
    tool_on_turn?: { tool: string; turn: number };
    /** How many candidates the last find_doctors reported — 1 means it landed on one. */
    last_candidates?: number;
    /** What the last find_doctors resolved the spoken terms to. */
    resolved_includes?: { speciality?: string; city?: string; language?: string };
    /**
     * At least one find_doctors call anywhere in the conversation returned this.
     * Order-independent, unlike last_candidates, and immune to Czech declension,
     * unlike answer_includes.
     */
    find_result_includes?: FindResultSpec;
    args_include?: Record<string, string | null>;
    answer_includes?: string[];
    /** Answer must quote the snapshot date, ISO or Czech "D. M. YYYY". */
    answer_includes_data_as_of?: boolean;
    /** One entry per turn; null skips that turn. Last-turn checks stay separate. */
    turn_behaviours?: (Exclude<Behaviour, "out_of_scope"> | null)[];
    behaviour?: Behaviour;
  };
};

const PASS_THRESHOLD = 0.8;

/** Every utterance in a case, single-turn or conversation. */
function caseTurns(testCase: Case): string[] {
  if (testCase.turns !== undefined) return testCase.turns;
  return testCase.utterance === undefined ? [] : [testCase.utterance];
}

/** What the result table shows: the turn the assertions are about. */
function caseLabel(testCase: Case): string {
  const turns = caseTurns(testCase);
  const last = turns.at(-1) ?? "";
  return turns.length > 1 ? `… ${last}` : last;
}


function checkCase(
  testCase: Case,
  answer: string,
  toolCalls: { name: string; input: Record<string, unknown> }[],
  turnAnswers: string[],
  turnTools: string[][],
  lastCandidates: number | null,
  lastResolved: { speciality: string | null; city: string | null; language: string | null } | null,
  findResults: readonly { matches: readonly { first_name: string; last_name: string }[]; candidates: number }[],
): string[] {
  const failures: string[] = [];
  const {
    tool,
    tool_not_called,
    args_include,
    answer_includes,
    answer_includes_data_as_of,
    behaviour,
    turn_behaviours,
    tool_on_turn,
    last_candidates,
    resolved_includes,
    find_result_includes,
  } = testCase.expect;

  if (find_result_includes !== undefined) {
    const matched = findResults.some((r) => findResultMatches(r, find_result_includes));
    if (!matched) {
      const seen = findResults
        .map((r) => `${r.matches[0] ? `${r.matches[0].first_name} ${r.matches[0].last_name}` : "none"}/${r.candidates}`)
        .join(", ");
      failures.push(
        `find_result_includes: no search returned ${JSON.stringify(find_result_includes)} (searches returned: ${seen || "nothing"})`,
      );
    }
  }

  if (resolved_includes !== undefined) {
    if (lastResolved === null) failures.push("resolved_includes: find_doctors never returned a result");
    else {
      for (const [field, want] of Object.entries(resolved_includes)) {
        const got = lastResolved[field as keyof typeof lastResolved];
        if (got !== want) failures.push(`resolved_includes: ${field} resolved to ${got ?? "null"}, expected ${want}`);
      }
    }
  }

  if (last_candidates !== undefined) {
    if (lastCandidates === null) failures.push("last_candidates: find_doctors never returned a result");
    else if (lastCandidates !== last_candidates) {
      failures.push(`last_candidates: expected ${last_candidates}, the last search reported ${lastCandidates}`);
    }
  }

  if (tool_on_turn !== undefined) {
    const onThatTurn = turnTools[tool_on_turn.turn - 1];
    if (onThatTurn === undefined) {
      failures.push(`tool_on_turn: turn ${tool_on_turn.turn} never ran`);
    } else if (!onThatTurn.includes(tool_on_turn.tool)) {
      failures.push(
        `tool_on_turn: expected ${tool_on_turn.tool} on turn ${tool_on_turn.turn}, that turn called ${onThatTurn.join(", ") || "nothing"}`,
      );
    }
    const early = turnTools.slice(0, tool_on_turn.turn - 1).findIndex((t) => t.includes(tool_on_turn.tool));
    if (early >= 0) {
      failures.push(`tool_on_turn: ${tool_on_turn.tool} was already called on turn ${early + 1}`);
    }
  }

  for (const [index, expected] of (turn_behaviours ?? []).entries()) {
    if (expected === null) continue;
    const turnAnswer = turnAnswers[index];
    if (turnAnswer === undefined) {
      failures.push(`turn ${index + 1}: no answer recorded`);
    } else if (!BEHAVIOUR_PATTERNS[expected].test(fold(turnAnswer))) {
      failures.push(`turn ${index + 1}: expected ${expected}, got "${turnAnswer.slice(0, 70)}"`);
    }
  }

  // Unconditional: an empty answer is dead air on a phone line, never an edge case.
  if (answer.trim().length === 0) {
    failures.push("EMPTY ANSWER — the caller hears silence; every path must say something");
  }

  // The fallback line means the agent gave up. Healthy cases never reach it.
  if (answer.includes(FALLBACK_ANSWER)) {
    failures.push("returned the give-up fallback line (loop cap, refusal, or empty model text)");
  }

  const matching = tool === undefined ? toolCalls : toolCalls.filter((c) => c.name === tool);
  if (tool !== undefined && matching.length === 0) {
    failures.push(`never called ${tool} (called: ${toolCalls.map((c) => c.name).join(", ") || "nothing"})`);
  }

  if (tool_not_called !== undefined && toolCalls.some((c) => c.name === tool_not_called)) {
    failures.push(`called ${tool_not_called} when it should not have`);
  }

  if (args_include !== undefined) {
    const hit = matching.some((call) =>
      Object.entries(args_include).every(([key, expected]) => {
        const actual = call.input[key];
        if (expected === null) return actual === null || actual === undefined;
        return typeof actual === "string" && fold(actual) === fold(expected);
      }),
    );
    if (!hit) {
      failures.push(`no ${tool ?? "tool"} call matched ${JSON.stringify(args_include)} (got ${JSON.stringify(matching.map((c) => c.input))})`);
    }
  }

  for (const needle of answer_includes ?? []) {
    if (!fold(answer).includes(fold(needle))) failures.push(`answer missing "${needle}"`);
  }

  if (answer_includes_data_as_of === true && !mentionsDate(answer, DATA_AS_OF)) {
    failures.push(`answer does not quote data_as_of (${DATA_AS_OF.slice(0, 10)} or "${new Date(DATA_AS_OF).getUTCDate()}. ${new Date(DATA_AS_OF).getUTCMonth() + 1}. ${new Date(DATA_AS_OF).getUTCFullYear()}")`);
  }

  if (behaviour === "out_of_scope") {
    // Deterministic, not phrasing-based: touched no data, named nobody, stayed short.
    // Judged on the closing turn: a conversation may search and then end out of scope.
    const lastTurnTools = turnTools.at(-1) ?? [];
    if (lastTurnTools.length > 0) {
      failures.push(`out_of_scope: last turn called ${lastTurnTools.join(", ")} — must not touch the snapshot`);
    }
    // Matched on the raw answer against the capitalised surname: folding turns
    // the commonest Czech adverb, "dobře", into the surname "Dobre".
    const named = namesADoctor(answer, SURNAMES);
    if (named.length > 0) {
      failures.push(`out_of_scope: answer names doctors (${named.join(", ")})`);
    }
    if (answer.length >= 200) {
      failures.push(`out_of_scope: answer is ${answer.length} chars, must stay under 200`);
    }
  } else if (behaviour === "ask_clarification") {
    // "Nemám ho, chcete obor, nebo město?" is a refusal wearing a question mark.
    if (!BEHAVIOUR_PATTERNS.ask_clarification.test(fold(answer))) {
      failures.push("expected behaviour ask_clarification");
    } else if (BEHAVIOUR_PATTERNS.not_found.test(fold(answer))) {
      failures.push("expected ask_clarification but the answer also reads as not_found");
    }
  } else if (behaviour !== undefined && !BEHAVIOUR_PATTERNS[behaviour].test(fold(answer))) {
    failures.push(`expected behaviour ${behaviour}`);
  }

  if (behaviour === "emergency" && answer.length >= EMERGENCY_MAX_CHARS) {
    failures.push(`emergency: answer is ${answer.length} chars, must stay under ${EMERGENCY_MAX_CHARS} so "155" is the whole message`);
  }

  return failures;
}

const CASES_FILE = process.env["CASES_FILE"] ?? "./evals/cases.json";
const cases = JSON.parse(readFileSync(CASES_FILE, "utf8")) as Case[];

const KNOWN_BEHAVIOURS = new Set<string>([...Object.keys(BEHAVIOUR_PATTERNS), "out_of_scope"]);
const KNOWN_TOOLS = new Set(["find_doctors", "get_doctor_contact"]);

// Every assertion is checked against the vocabulary before a single call is
// billed: a typo in a tool name would otherwise pass silently for ever.
function invalid(testCase: Case): string | null {
  const { behaviour, turn_behaviours, tool, tool_not_called, tool_on_turn } = testCase.expect;
  if (behaviour !== undefined && !KNOWN_BEHAVIOURS.has(behaviour)) return `unknown behaviour ${behaviour}`;
  for (const value of turn_behaviours ?? []) {
    if (value !== null && !KNOWN_BEHAVIOURS.has(value)) return `unknown turn behaviour ${value}`;
  }
  for (const [label, value] of [["tool", tool], ["tool_not_called", tool_not_called], ["tool_on_turn.tool", tool_on_turn?.tool]] as const) {
    if (value !== undefined && !KNOWN_TOOLS.has(value)) return `unknown tool in ${label}: ${value}`;
  }
  const turns = caseTurns(testCase).length;
  if (turn_behaviours !== undefined && turn_behaviours.length !== turns) {
    return `turn_behaviours has ${turn_behaviours.length} entries for ${turns} turns`;
  }
  if (tool_on_turn !== undefined && (tool_on_turn.turn < 1 || tool_on_turn.turn > turns)) {
    return `tool_on_turn.turn ${tool_on_turn.turn} is outside 1..${turns}`;
  }
  return null;
}

for (const [index, testCase] of cases.entries()) {
  const problem = invalid(testCase);
  if (problem !== null) {
    console.error(`case ${index + 1}: ${problem}`);
    process.exit(1);
  }
}

for (const [index, testCase] of cases.entries()) {
  if (testCase.utterance !== undefined && testCase.turns !== undefined) {
    console.error(`case ${index + 1}: set either utterance or turns, not both`);
    process.exit(1);
  }
}

const runnable = cases.filter((c) => {
  const turns = caseTurns(c);
  return turns.length > 0 && turns.every((t) => t.trim().length > 0);
});
if (runnable.length < cases.length) {
  console.error(`${cases.length - runnable.length} of ${cases.length} cases have an empty utterance — fill them in before running evals`);
  process.exit(1);
}

// After every gate a real run would hit, so "valid" means "this would run".
if (process.argv.includes("--validate-only")) {
  console.log(`${cases.length} cases valid`);
  process.exit(0);
}
/** Every individual turn, so latency can be reported per turn as well as per case. */
const turnDurations: number[] = [];

const results: {
  label: string;
  failures: string[];
  answer: string;
  preamble: string;
  ms: number;
  ttft: number | null;
  outcome: Outcome;
}[] = [];

for (const [index, testCase] of runnable.entries()) {
  process.stdout.write(`  running ${index + 1}/${runnable.length}\r`);
  const started = performance.now();
  try {
    // A conversation is replayed in order; only the last turn is asserted on.
    let history: Awaited<ReturnType<typeof runTurn>>["messages"] = [];
    let answer = "";
    let preamble = "";
    let ttft: number | null = null;
    const turnAnswers: string[] = [];
    const turnTools: string[][] = [];
    let lastCandidates: number | null = null;
    let lastResolved: { speciality: string | null; city: string | null; language: string | null } | null = null;
    const findResults: { matches: { first_name: string; last_name: string }[]; candidates: number }[] = [];
    // Accumulated across the whole conversation, so tool_not_called means
    // "never called on this call", not "not on the last turn".
    const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
    for (const turn of caseTurns(testCase)) {
      const turnStarted = performance.now();
      const result = await runTurn(turn, history, { trace: false });
      turnDurations.push(Math.round(performance.now() - turnStarted));
      history = result.messages;
      answer = result.answer;
      preamble = result.preamble;
      if (result.ttft_ms !== null) ttft = result.ttft_ms;
      turnAnswers.push(result.answer);
      turnTools.push(result.toolCalls.map((c) => c.name));
      for (const call of result.toolCalls) {
        if (call.name !== "find_doctors") continue;
        const found = findDoctors({
          surname: str(call.input["surname"]), first_name: str(call.input["first_name"]),
          speciality: str(call.input["speciality"]), city: str(call.input["city"]),
          language: str(call.input["language"]),
        });
        lastCandidates = found.candidates;
        lastResolved = found.resolved;
        findResults.push({ matches: found.matches, candidates: found.candidates });
      }
      toolCalls.push(...result.toolCalls);
    }
    results.push({
      label: caseLabel(testCase),
      answer,
      preamble,
      ttft,
      ms: Math.round(performance.now() - started),
      outcome: classify(answer, (turnTools.at(-1) ?? []).map((name) => ({ name }))),
      failures: checkCase(testCase, answer, toolCalls, turnAnswers, turnTools, lastCandidates, lastResolved, findResults),
    });
  } catch (error) {
    results.push({
      label: caseLabel(testCase),
      answer: "",
      preamble: "",
      ttft: null,
      ms: Math.round(performance.now() - started),
      outcome: "other",
      failures: [`threw: ${String(error)}`],
    });
  }
}

console.log("");
for (const result of results) {
  const ok = result.failures.length === 0;
  console.log(
    `${ok ? "✅" : "❌"}  ${String(result.ms).padStart(6)} ms  ${result.label.slice(0, 52).padEnd(54)} ${result.answer.slice(0, 52)}`,
  );
  if (result.preamble.length > 0) console.log(`       💬 ${result.preamble.slice(0, 70)}`);
  for (const failure of result.failures) console.log(`       ↳ ${failure}`);
}

const passed = results.filter((r) => r.failures.length === 0).length;
const score = results.length === 0 ? 0 : passed / results.length;

// Three units, never mixed: one turn is what a caller waits through, one case is
// a whole conversation and may be three of them, and TTFT is one streamed call.
const perTurn = stats(turnDurations);
const perCase = stats(results.map((r) => r.ms));
const ttft = stats(results.map((r) => r.ttft).filter((t): t is number => t !== null));

console.log(`\n${passed}/${results.length} passed — ${(score * 100).toFixed(0)}% (threshold ${PASS_THRESHOLD * 100}%)`);
console.log(`  turn ms          avg ${perTurn.avg}, max ${perTurn.max} (${perTurn.n} turns)`);
console.log(`  conversation ms  avg ${perCase.avg}, max ${perCase.max} (${perCase.n} cases)`);
if (ttft.n > 0) console.log(`  TTFT ms          avg ${ttft.avg}, max ${ttft.max} (${ttft.n} streamed)`);

console.log("\noutcome breakdown (what happened, not what was expected):");
for (const outcome of OUTCOMES) {
  const n = results.filter((r) => r.outcome === outcome).length;
  console.log(`  ${outcome.padEnd(18)} ${String(n).padStart(3)}`);
}

if (score < PASS_THRESHOLD) process.exit(1);
