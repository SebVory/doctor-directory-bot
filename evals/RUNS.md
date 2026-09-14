# Eval run log

Every run that spends money on the API, so no question gets paid for twice.
Offline runs (`npm test`, `evals/stt-offline.ts`) are free and not logged here.

A failure is only worth acting on once its cause is known, so each one is
attributed: **agent** (the bot did the wrong thing), **checker** (the assertion
was wrong), **case** (the expectation described something the data cannot do),
or **variance** (the same input behaved differently across runs).

---

## 2026-09-11 · 3 verified cases · first green run

State: `cases.json` with the three hand-written cases, before the STT transcripts.
Result: **3/3, 100%** · latency avg 6844 ms, max 8353 ms.
Decision: baseline accepted; the runner and its assertions work end to end.

## 2026-09-11 · narrowing conversation × 3

State: multi-turn support just added, `turn_behaviours` and accumulated tool calls.
Result: **3/3** after two assertion fixes.
Failures — `ask_clarification` did not recognise "mám jedenáct" or "…, nebo
Cristina?" (**checker**, pattern widened); `answer_includes: ["Alina"]` missed the
accusative "Alinu" (**case**, matched on the stem instead).
Decision: both fixed before the run was counted; the bot was right both times.

## 2026-09-14 · latency experiment · 3 cases × 3 runs per condition

State: `0aa483e`-ish, before the STT work. ~150 billed calls.

| condition | pass | avg ms |
|---|---|---|
| Opus 5, effort medium | 3/3, 3/3, 3/3 | 5949 / 6437 / 5519 |
| Sonnet 5, effort medium | 1/3, 3/3, 1/3 | 6257 / 5850 / 6722 |
| Haiku 4.5 (rejects `effort`) | 0/3 | 16502, one call 40401 |
| Opus 5, effort low | 3/3, 3/3 | 5976 / 5983 |
| + trimmed tool payload | 3/3 ×3 | 7132 mean over 6 runs |
| + shorter system prompt | **2/3 ×3** | rejected, broke the same case each time |
| + prompt caching, interleaved | 3/3 | inconclusive on latency |

Sonnet's failures were **agent**: it ignored `needs_confirmation` and reported a
low-confidence hit as not-found.
Decision: keep Opus 5 at effort medium. Keep the payload trim. Keep caching for
cost, not speed. Reject the shorter prompt. Thinking ruled out separately —
`thinking_tokens` came back 0, 0, 0, 0, 7, 19, and disabling it changed nothing.
TTFT on the spoken call measured at 1.5–1.9 s against ~7 s end to end, which is
what made streaming the lever rather than the model.

## 2026-09-14 · 43 real STT transcripts · live measurement

State: before the four transcript-driven fixes. ~122 billed calls.
Result: **19 pass, 14 fail, 10 free-text expectations** (of the free-text ten, my
own reading was 9 pass / 1 fail).
Causes: several failures were **checker** — the Czech expectations are
conditional ("1 → hodiny, víc → ask") and the mapper reduced them to one outcome.
The **agent** failures that mattered: confirming names the search never found
(Hordyska 0.14, Čiová 0.22, Dumitrescu 0.31 offered to a caller who said
Popescu), naming one doctor out of 186, and a mishearing ("restaurace" for
"doktorka") turning a lookup into a refusal.
Decision: four fixes — suggestion floor at 0.40, `must_ask` in the tool result,
an STT-noise prompt rule, and a confirm threshold conditional on how much
independent evidence the caller gave. The matcher was left alone: the same
transcripts run offline gave 31/38 and failed on entirely different things,
because the model repairs the dictation before the tool sees it.

## 2026-09-14 · 29 cases rebuilt from transcripts · two runs

State: `1b35dc8` plus the README rewrite. ~150 billed calls.

| | run 1 | run 2 |
|---|---|---|
| score | **26/29, 90%** | **26/29, 90%** |
| latency avg / max | 9149 / 27771 ms | 8066 / 21011 ms |
| outcome breakdown | ask 16, not_found 4, contact 2, emergency 2, oos 2, found 2, confirm 1 | ask 15, not_found 5, found 3, emergency 2, oos 2, contact 1, confirm 1 |

Four distinct failures:

- *"slyším vás **dobře**"* flagged as naming a doctor — **checker**. `dobře` folds
  to `dobre`, which is a surname in the data. The check now runs on the raw
  answer against the capitalised surname.
- *"aktuální k **jedenáctému září 2026**"* rejected — **checker**. The date was
  right and spoken the way a voice bot says it; the matcher only accepted
  `11. 9. 2026`. It now accepts the spelled-out Czech form.
- *"… Dáryu"* expected to land on one Dumitrescu — **case**. There is no Daria
  Dumitrescu in Cluj-Napoca; the eleven there are Irina, Radu, Bogdan, Maria,
  Andrei, Cristina, Diana, Tudor, Alina, Laura, Ionut. Repointed at Bogdan, who
  is also a real transcript.
- Targu Mureš and Čiová behaved differently between the two runs — **variance**.
  Both answers were defensible each time; the cases now assert only what both
  runs agreed on: a question was asked, no doctor was named as fact, no contact
  was fetched.

Decision: the agent's own behaviour was **28/29**. No agent change made. Two
checker fixes, one case fix, two cases loosened. README figures left unfilled
until a run measures the fixed assertions.

## 2026-09-14 · aborted after 17 of 38 cases

State: mid-way through the review fix list, cases.json just extended to 38.
Cause: the runner was chained onto a shell command meant only to check that the
new validation accepted the file. Killed at case 17, roughly 34 billed calls,
no usable result. Validation is now checked with a deliberately *invalid* case
file, which exits before any call is made.

---

## Next run

Nothing since the two 29-case runs has been measured against the API. The next
run is the first to exercise: the given-name confirmation band, the
surname-substitution flag, the surname-first question only when a surname was
given, tool-error handling, the ask/not-found split, the phone-number-safe 155
pattern, the widened date forms, `last_candidates`, and nine new cases from the
transcripts. 38 cases, roughly 100 billed calls.

Note on earlier numbers: the follow-up sections in `scripts/stt-report.ts` were
paired with their setup turn by substring match, so the confirmation and
"after one doctor was found" sections replayed after a setup that had found
nobody. Opening-utterance results are unaffected; follow-up results from that
script describe the wrong conversation and should not be compared against.
