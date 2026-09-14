# Eval run log

Every **eval run** that spends money on the API, so no question gets paid for
twice. Offline runs (`npm test`, `evals/stt-offline.ts`) are free and not logged.

Not logged, and worth being honest about: ad-hoc verification calls made with
`npm run doctor` while building — checking a prompt rule took hold, watching a
narrowing conversation, forcing the loop cap. Several dozen over the work, small
individually and never counted. If spend ever matters, that is where the
unmeasured part of it is.

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

## 2026-09-14 · 38 cases · after the review fix list

State: `59cf2c5` plus the B2 tidy-up. ~100 billed calls.
Result: **35/38, 92%** · conversation ms avg 8528, max 22330 · **TTFT avg 1733 ms,
max 2608 ms** over 31 streamed calls.
Outcome breakdown: ask_clarification 22, contact 6, not_found 4, out_of_scope 3,
emergency 3, **confirm_name 0**, found 0.

Three failures, two of them one root cause.

- *Váselysku* expected `confirm_name`, asked for a city instead — **case**. The
  model repaired the surname to "Vasilescu" before calling the tool, so the 0.44
  score that triggers a read-back never reached the store. The same repair broke
  the *"Jo jo to je on"* conversation downstream: turn 1 asked rather than
  confirmed, so the confirmation had nothing to accept, and the last search
  reported 291 rather than 1.
- *"… Bogdana"* fetched the contact when the case said it must not — **case**.
  The opening sentence was *"jestli máte číslo na doktora Dumistrésku"*, so under
  the rule added in A8 the number is due once one doctor remains. The case still
  carried the older "never in the first answer" expectation.

Fixes applied (cases only, the agent was not touched): the Váselysku case now
asserts a question and no volunteered contact rather than `confirm_name`; the
"Jo jo to je on" conversation asserts only the contact guard; the Bogdana
conversation now expects the contact on turn 3 with `last_candidates: 1`.

**Worth its own line: `confirm_name` came back 0 across all 38 cases.** The
read-back path is reachable in unit tests, where the store is called directly
with a mangled surname, but in a real call the model repairs the spelling first,
so the low score the path depends on rarely arrives. Either the path is close to
dead in production, or it only fires on manglings the model cannot repair — and
nothing here distinguishes those yet. That is the first question for the next
run, not a fix.

## 2026-09-14 · subset verification · the three repointed cases

State: the same code, only the three case expectations changed. ~14 billed calls.
Result: **3/3**, conversation ms avg 14423, max 22676, TTFT avg 1951 ms, max 2832 ms.

```
✅   9102 ms  Dobrý den, potřeboval bych kontakt na paní Váselysku   Doktorek Vasilescu mám víc. V jakém městě ordinuje —
✅  22676 ms  … Bogdana                                              Mám ho: Bogdan Dumitrescu, infektolog v Kluži. Telef
✅  11492 ms  … Jo jo to je on                                       Potřebuju vědět, které město to je. Řeknete mi ho?
```

The full set was not re-run: only three expectations moved, and re-running the
other 35 would have bought nothing but a bill. `confirm_name` was 0 here too, on
the one case written to provoke it — consistent with the finding below rather
than with a flaky run.

---

## Next run

The three case fixes above are unmeasured. The open question is whether
`confirm_name` can fire at all in a real call, given the model repairs mangled
surnames before the tool sees them — worth one targeted run rather than a full
sweep.

Note on earlier numbers: the follow-up sections in `scripts/stt-report.ts` were
paired with their setup turn by substring match, so the confirmation and
"after one doctor was found" sections replayed after a setup that had found
nobody. Opening-utterance results are unaffected; follow-up results from that
script describe the wrong conversation and should not be compared against.
