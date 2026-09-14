/**
 * Behavioural regression gate. Every case runs one real turn through the agent and
 * checks what it *did* (tool calls) as well as what it said.
 */
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { FALLBACK_ANSWER, runTurn } from "../src/doctor-agent.js";
import { DB_PATH } from "../src/ingest.js";
import {
  BEHAVIOUR_PATTERNS,
  type Behaviour,
  EMERGENCY_MAX_CHARS,
  OUTCOMES,
  type Outcome,
  classify,
  fold,
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

/** Does the answer quote the snapshot date in either accepted form? */
function mentionsDataAsOf(answer: string): boolean {
  if (DATA_AS_OF === "") return false;
  if (answer.includes(DATA_AS_OF.slice(0, 10))) return true; // 2026-09-11

  // The model speaks the local date; after ~22:00 CEST that is a day ahead of UTC,
  // so both are accepted rather than failing the case on a timezone boundary.
  const date = new Date(DATA_AS_OF);
  const forms = [
    [date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCFullYear()],
    [date.getDate(), date.getMonth() + 1, date.getFullYear()],
  ];
  return forms.some(([d, m, y]) => new RegExp(`\\b${d}\\.\\s*${m}\\.\\s*${y}\\b`).test(answer));
}

function checkCase(
  testCase: Case,
  answer: string,
  toolCalls: { name: string; input: Record<string, unknown> }[],
  turnAnswers: string[],
  turnTools: string[][],
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
  } = testCase.expect;

  if (tool_on_turn !== undefined) {
    const onThatTurn = turnTools[tool_on_turn.turn - 1];
    if (onThatTurn === undefined) {
      failures.push(`tool_on_turn: turn ${tool_on_turn.turn} never ran`);
    } else if (!onThatTurn.includes(tool_on_turn.tool)) {
      failures.push(
        `tool_on_turn: expected ${tool_on_turn.tool} on turn ${tool_on_turn.turn}, that turn called ${onThatTurn.join(", ") || "nothing"}`,
      );
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

  if (answer_includes_data_as_of === true && !mentionsDataAsOf(answer)) {
    failures.push(`answer does not quote data_as_of (${DATA_AS_OF.slice(0, 10)} or "${new Date(DATA_AS_OF).getUTCDate()}. ${new Date(DATA_AS_OF).getUTCMonth() + 1}. ${new Date(DATA_AS_OF).getUTCFullYear()}")`);
  }

  if (behaviour === "out_of_scope") {
    // Deterministic, not phrasing-based: touched no data, named nobody, stayed short.
    if (toolCalls.length > 0) {
      failures.push(`out_of_scope: called ${toolCalls.map((c) => c.name).join(", ")} — must not touch the snapshot`);
    }
    const named = SURNAMES.filter((surname) => new RegExp(`\\b${fold(surname)}\\b`).test(fold(answer)));
    if (named.length > 0) {
      failures.push(`out_of_scope: answer names doctors (${named.join(", ")})`);
    }
    if (answer.length >= 200) {
      failures.push(`out_of_scope: answer is ${answer.length} chars, must stay under 200`);
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
for (const [index, testCase] of cases.entries()) {
  const behaviour: unknown = testCase.expect.behaviour;
  if (behaviour !== undefined && !KNOWN_BEHAVIOURS.has(String(behaviour))) {
    console.error(`case ${index + 1}: unknown behaviour ${JSON.stringify(behaviour)} — expected one of ${[...KNOWN_BEHAVIOURS].join(", ")}`);
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
const results: {
  label: string;
  failures: string[];
  answer: string;
  preamble: string;
  ms: number;
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
    const turnAnswers: string[] = [];
    const turnTools: string[][] = [];
    // Accumulated across the whole conversation, so tool_not_called means
    // "never called on this call", not "not on the last turn".
    const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
    for (const turn of caseTurns(testCase)) {
      const result = await runTurn(turn, history, { trace: false });
      history = result.messages;
      answer = result.answer;
      preamble = result.preamble;
      turnAnswers.push(result.answer);
      turnTools.push(result.toolCalls.map((c) => c.name));
      toolCalls.push(...result.toolCalls);
    }
    results.push({
      label: caseLabel(testCase),
      answer,
      preamble,
      ms: Math.round(performance.now() - started),
      outcome: classify(answer, toolCalls),
      failures: checkCase(testCase, answer, toolCalls, turnAnswers, turnTools),
    });
  } catch (error) {
    results.push({
      label: caseLabel(testCase),
      answer: "",
      preamble: "",
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
const times = results.map((r) => r.ms);
const avgMs = times.length === 0 ? 0 : Math.round(times.reduce((a, b) => a + b, 0) / times.length);
const maxMs = times.length === 0 ? 0 : Math.max(...times);
console.log(
  `\n${passed}/${results.length} passed — ${(score * 100).toFixed(0)}% (threshold ${PASS_THRESHOLD * 100}%) · latency avg ${avgMs} ms, max ${maxMs} ms`,
);

console.log("\noutcome breakdown (what happened, not what was expected):");
for (const outcome of OUTCOMES) {
  const n = results.filter((r) => r.outcome === outcome).length;
  console.log(`  ${outcome.padEnd(18)} ${String(n).padStart(3)}`);
}

if (score < PASS_THRESHOLD) process.exit(1);
