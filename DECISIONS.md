# Decision log

What was measured, what it showed, and what was decided because of it. Entries
that record a *rejected* idea matter as much as the accepted ones – several
plausible changes turned out to buy nothing, and that is only visible because
they were measured before being built.

Numbers come from the full 7029-row interview snapshot unless stated otherwise.
The committed `data/data-sample.json` is a smaller stratified test fixture, not
the source for the full-snapshot analysis.

---

## 1. The endpoint is never called during a call

**Question.** The hospital exposes one endpoint returning the whole list, taking
~10 minutes. Can it be called live?

**Measured.** No measurement needed – 10 minutes against a phone call answers it.

**Decided.** Pull a snapshot on a schedule, serve every call from local SQLite.
A full-scan lookup over 7029 rows measured **9.7 ms** by hand at the time, before
dominance filtering and the given-name pass were added; there is no benchmark
script in the repo reproducing it. The order of magnitude is the point – nothing
remote is worth querying at call time.

---

## 2. Snapshot replacement is all-or-nothing

**Question.** How to replace a snapshot without a window where the bot answers
from half a table?

**Decided.** Stage into `doctors_new`, then `DROP` + `RENAME` + rebuild indexes +
update `meta` inside one `db.transaction(...)`. SQLite makes DDL transactional,
so a throw anywhere rolls back and the old table stays live.

**Guards.** Abort *before* the swap if the new snapshot has fewer than 70% of the
previous row count, or if more than 5% of rows fail Zod validation. A bad
snapshot then costs freshness, not service – and the bot can still say how old
its data is.

---

## 3. Doctor identity is not modelled – and the obvious id is unsafe

**Question.** How to identify a row across snapshots?

**Measured.** `last_name|first_name|clinic_name` puts **1285 rows into 616
colliding groups** – 669 rows beyond the first in each group, which is the figure
the README quotes. Every one of those groups carries **different phone numbers
and addresses** – they are different people, or the same person at different
practices.

**Decided.** Nothing is keyed to a doctor (no bookings, no history), so identity
does not need solving: the snapshot is replaced wholesale and a doctor absent
from it does not exist. The id is a per-snapshot hash including `speciality` and
`phone`, giving **7029/7029 distinct**. Without that, `get_doctor_contact` would
read out the wrong phone number for ~9.5% of lookups.

---

## 4. What the data actually looks like

**Measured.**

| | |
|---|---|
| rows | 7029 |
| built from | 30 first names × 26 surnames = 780 distinct full names |
| full names belonging to exactly one doctor | **0** |
| most-shared full name | 20 people |
| unique after + city | 5744 (1285 rows still ambiguous) |
| unique after + city + speciality | **6969 = 99.1%** |
| irreducible even then | 60 rows in 30 pairs |

**Decided.** Asking for city and speciality is not an optimisation, it is the
minimum viable question set. No lookup can end on a name alone. City is the
better first question (42 values, 141–196 doctors each) than speciality (20
values, 325–381 each).

The 43 raw macOS transcripts, the 38-case agent eval of 14 September, and the
44-case eval that stands today (42 until two guard cases were added on
14 September) are different collections and must not be compared as if they had
the same denominator. The current score is **42/44**; every other figure in this
file is dated and historical.

---

## 5. Four fields in the data are traps

**Measured.**

- **`clinic_name` is location-linked, not doctor-unique** – in the full snapshot,
  each of the 42 clinic names maps to exactly one location, and each location has
  one clinic name (`Clinica {city} Care`). Multiple doctors can share that clinic.
- **`county` is `location` one level up** – no city of the 42 sits in two
  counties, so the county follows from the city, and there are only 34 of them
  because six span several cities (Cluj covers Cluj-Napoca and Turda). Asking for
  the county therefore cuts less than asking for the city and adds nothing once
  the city is known. Same shape as the clinic trap, one level coarser.
- **`postal_code` is noise** – 173 distinct postal codes inside Cluj-Napoca alone.
- **`email` is shared by 616 groups with multiple rows**, because it derives from
  name + clinic. `phone` is the only genuinely unique field (7029/7029).

**Decided.** `clinic_name` is out of the disambiguation set – asking which clinic
asks which city in less natural words and adds no information in this snapshot.
It stays in the tool payload so the bot can say it once one doctor remains.
`county` is ingested and stored, and queried by nothing: a caller who offers one
is answered through the city, never filtered by it. `postal_code` is never used
for location. Contacts carry `email_shared`, and the
bot says the address belongs to the clinic while the phone is the direct line.

Two smaller shapes, recorded rather than acted on: `availability` is one of five
templates, so it answers "how late are they open" and can never disambiguate two
doctors, and `education` is one of six universities.

**Recheck rule.** This is a measured property of the current full snapshot, not
a universal property of hospital data. If a future snapshot has a location with
multiple clinic names, a clinic name in multiple locations, or a city split
across counties, rerun the ambiguity analysis and reconsider whether those
attributes are useful for disambiguation.

---

## 6. Czech feminine surnames: correctness was fine, confidence was not

**Question.** A caller says "doktorka Munteanuová"; the data says "Munteanu".

**Measured.** Across all 26 surnames × 3 declined forms (78 utterances), trigram
overlap already resolved **every one** to the right surname. What it did not do
was score them confidently: mean **0.837**, and **24 of 78** landed under 0.8.
`Rusuová` against `Rusu` scored 0.721.

**Decided.** Strip the suffix on the *query* side only – mean goes to **1.000**,
nothing under 0.8. (Measured before the data side reverted to plain `normalize`;
the stored column keeps the surname as written, the caller's words get stripped.)
This matters because the confirm-the-name branch is score-gated: the bot was
asking "did I hear you right?" about names it had heard perfectly.

**Constraint discovered.** It cannot live in the general `normalize()`, because
the city `Craiova` would become `krai`. Hence a separate `normalizeSurname()`
used for surnames only, with a test asserting `normalize("Craiova")` is untouched.

---

## 7. The transliteration table is not overfitted, and one gap was not a limit

**Question.** Was the table tuned to the handful of names used to build it?

**Measured, before the `ije`/`ija`/`ya` rules below.** Five surnames never used
in its construction: Draghomír→Dragomir 0.765, Ijakob→Iacob 0.857, Rusů→Rusu
1.000, Stánová→Stan 0.721, Jonesku→Ionescu 0.800. All five resolved, worst 0.72.

**The same five today**, with those rules in place: Draghomír 0.765, Ijakob
**1.000**, Rusů 1.000, Stánová **1.000**, Jonesku 0.800. Worst is now 0.765. The
two that moved are exactly the ones carrying the Czech glide the rules describe,
which is the point of the entry: the gap was in the table, not in trigrams.

**Separately (before the `ije`/`ija` rules).** `Ilije` against `Ilie` scored **0.000** – no shared trigram. This looked like a hard limit of trigrams on four-letter surnames. It was not: the table had no rule for the glide a Czech ear inserts. Adding `["ije","je"]` and `["ija","ja"]` took it to **1.000**, and `Dijakonu`→`Diaconu` from 0.727 to 1.000, with nothing regressing. A phonetic fallback was planned and turned out to be unnecessary.

**A rule with a cost.** `["ya","a"]` resolves `Nyagu`→`Neagu` at 1.000 – correct, since that is how a Czech writes Neagu. It also removed the only low-confidence fixture the confirmation path was tested with. Accepted anyway; `Nyštor`→`Nistor` at 0.50 became the confirm fixture.

---

## 8. Latency: four plausible levers, three of them worthless

**Question.** A turn takes ~7 s. Where does it go?

**Measured, three runs per condition.**

| condition | pass | avg ms |
|---|---|---|
| Opus 5, effort medium | 3/3, 3/3, 3/3 | 5949 / 6437 / 5519 |
| Sonnet 5, effort medium | 1/3, 3/3, 1/3 | 6257 / 5850 / 6722 |
| Haiku 4.5 (rejects `effort` outright) | 0/3 | 16502, one call 40401 |
| Opus 5, effort **low** | 3/3, 3/3 | 5976 / 5983 |

- **Model choice is not the lever.** Sonnet is the same speed and materially less
  reliable – it ignored `needs_confirmation` and treated a low-confidence hit as
  not-found in two of three runs.
- **Effort is not the lever.** 5980 vs 5968 ms.
- **Thinking is not the lever.** `output_tokens_details.thinking_tokens` came back
  **0, 0, 0, 0, 7, 19**. Disabling thinking entirely changed nothing.
- **Payload trim** (dropping contact details, hours, rating and seniority from
  search results) moved 7309 → 7132 ms. Kept, small but free.
- **Prompt caching**: interleaved A/B rounds went A-better, A-better, B-better.
  Inconclusive on latency; within-condition spread (6.1–10.1 s) swamps it. Kept
  for **cost**, not speed – 1650 tokens read from cache on every call, so two
  calls per turn cost ~1.35× the prefix instead of 2×.

**What the number actually is.** Time to first token on the spoken call is
**1.5–1.9 s** against ~7 s end-to-end. Most of the wait is generating text nobody
needs to wait through.

**Decided.** Stream the spoken call and record TTFT. Return the model's filler
("Moment, podívám se") separately as `preamble` instead of gluing it to the
answer, so a voice runtime can play it during the search. The tool-decision call,
which is never spoken, stays non-streaming.

**Found while instrumenting.** The filler was sometimes **English** – *"I'll look
her up right away."* – and was being spoken after the search rather than during
it. Fixed by separating it and adding an explicit Czech-only rule.

---

## 9. Test data: coverage has to be constructed

**Measured.** A positional slice of the snapshot loses whole categories – a cut
from the middle missed **Psychiatry entirely**, the speciality in the flagship
two-Dumitrescu case, plus 20 of 42 towns. A lead cut missed 9 towns.

**Decided.** `make-sample.ts` builds a 500-row slice that covers every speciality,
location, language and surname, pins the ambiguous groups, the id-collision groups
and the irreducible pairs, then stride-fills to keep the distribution. Deterministic,
regenerable, never hand-edited. Tests read it, so a fresh clone runs green without
the 3 MB snapshot.

The sample is intentionally not the analytical source for the 7029-row claims.
It is a regression fixture designed to preserve important edge cases in a small,
committed file.

---

## 10. Searching: a wide net is right only while the matcher is unsure

**Measured.** Searching "Dumitresku" returned **565 plausible candidates** – 277
Dumitrescu at 1.000 *and* 288 Dumitru at 0.765, which the fuzzy matcher admits on
purpose.

**Decided.** Once any candidate reaches 0.95, drop everything under 0.85. 565
becomes **277**. Below that trigger the wide net stays, because `Nyštor` must
still reach `Nistor` at 0.50. Two later additions sit on top: nothing under 0.40
is offered at all, and a surname the caller said that is a *real* surname in the
data must never be silently replaced by a different real one.

**Second decision.** Reading out three arbitrary names from hundreds is not an
answer. The store computes which single question splits the remaining candidates
best – smallest worst-case bucket – and returns it with its options. Asking which
city removes **544 of 565**. Surname is checked first and outside that metric – but
only when the caller actually said a surname: a metric rewarding many distinct
values would hand the question to city (42 values) every time, while asking
"Dumitrescu, or Dumitru?" of someone who only named a town is a question they
cannot answer.

---

## 11. Two bugs found by asking what the model actually receives

**Unresolved terms were silently dropped.** A city the matcher could not place fell
out of the filter, so "kardiolog v Brně" returned three cardiologists in Romania
and the model was never told why. Terms that do not resolve now return no matches
and name themselves in `unresolved`.

**The shortlist and the candidate count disagreed.** `matches` was sliced straight
off the scored rows while `candidates` counted only rows above the confirm
threshold. With a narrow prefilter the two diverged:

```
findDoctors({ surname: "Džordžesku", city: "Alba Iulia", speciality: "Dermatology" })
  candidates=1  needs_confirmation=false
    0.750  Cosmin Georgescu
    0.308  Mihai Ionescu      <-- shipped anyway
```

The model was told there was one candidate and no need to confirm, then handed a
list it could read a different surname from. Fixed by deriving both from the same
set – but only when something clears the threshold, because below it the best
guess is the name the bot reads back to confirm.

---

## 12. Real STT transcripts: the offline measurement was misleading

**Question.** How does the system handle verbatim Czech dictation?

**Measured twice.** Feeding the raw transcript text straight to the matcher gave
31 match / 7 miss. Running the same 43 transcripts through the agent gave 19 pass /
14 fail – and they fail on almost entirely different things.

**Why.** The model repairs most STT damage before the tool sees it:

```
STT wrote "Kůži"       → model passed "Kluž"      → Cluj-Napoca
STT wrote "ploj testi" → model passed "Ploješť"   → Ploiesti
STT wrote "Santumare"  → model passed "Satu Mare" → found Andrei Rusu 1.00
STT wrote "Rusové"     → model passed "Rusu"      → 1.000
```

**Decided at the time.** Do not build the matcher fixes the offline run appeared
to justify – they would fix zero real transcripts, because the model already
passes `Satu Mare`. A `y→i` fold measured **0.436 → 0.436**: worth nothing.

**Withdrawn the same day – see §15.** That conclusion rested on the model
repairing the input, which is a prior it volunteers rather than behaviour anyone
specified or tests cover. Once names and cities are passed verbatim, the matcher
has to do the work the model was doing for free, and the city changes went in:
space-insensitive comparison, a lower floor for cities than for specialities, and
synonyms lifted from the transcripts. Offline over the 43 transcripts that moved
31 match / 7 miss to **35 / 3**, with no false positive among the nine towns
outside the network and all 42 real locations still resolving to themselves.

**Where that claim stops.** Those nine towns were a one-off check and only
Ostrava is pinned by a test. Re-run later against 55 Czech and Slovak place
names, the 0.55 city floor produces two false positives: "Galanta" resolves to
Galati and "Sibiř" to Sibiu. Both are real things a caller could say, and the
bot would silently search the wrong city rather than say it does not have it.
Two in 55 is the honest number; raising the floor would cost the mishearings the
floor was lowered for, so it is a threshold to revisit with a billed run, not a
one-line change. The check is now a test rather than a memory.

The `y→i` measurement stands: it was worthless then and is worthless now.

---

## 13. A threshold that cannot exist

**Question.** A given name was allowed to stand in for a neighbour – "Ana"
returning Diana. Raise the floor so it cannot?

**Measured.**

```
Dáryu vs Daria   0.483   ← a real transcript, must be kept
Ana   vs Diana   0.500   ← must not be acted on
```

**Decided.** The one that must be rejected scores *higher* than the one that must
be kept, so no floor separates them. A floor at 0.75 drops both; a floor at 0.45
keeps both. What separates them is not a number, it is asking: the floor now only
removes noise, and a second band (0.85) makes anything below it read the name back.
Worth remembering the shape of this – when two cases invert across a threshold,
the threshold is the wrong instrument.

---

## 14. A flag that never reached the model

**Question.** A caller says a surname that really exists and the best hit carries
a different real surname. Never substitute silently.

**Built.** The store computes `surname_substituted`, returns it, forces a
confirmation, and is unit-tested.

**Found on review.** It was not in the tool payload and no prompt rule mentioned
it, so in a live call it did nothing beyond a generic read-back. Three layers
agreed the feature existed – the implementation, the type, and the test – and the
model never saw it.

**Decided.** Unit tests on a store function prove the function. They prove
nothing about whether the agent receives its output. Anything added to
`FindResult` now gets checked at the payload and in the prompt before it counts as
done.

---

## 15. The repair that disabled a safety branch

**Question.** After the transcript fixes, how often does the read-back path fire?

**Measured.** `confirm_name` came back **0** across all 38 cases, and **0** again
in a three-case subset containing the one case written to provoke it.

**Why.** The model repairs a mangled surname before calling the tool. The low
score the branch depends on never arrives at the store. The same behaviour that
made the city fixes unnecessary – "Kůži" arriving as "Kluž" – also means
"Váselysku" arrives as "Vasilescu" at 1.000 instead of 0.44.

**Decided.** Fixed by the simpler half of the proposal. The tool takes one
surname field and the prompt tells the model to pass it verbatim, mangling
included; the store owns matching, because it is the only component that can see
which names exist. A two-field `surname_as_heard` / `surname_guess` design was
drafted and is not needed unless the model turns out to keep repairing anyway –
that is the question the next run answers, and the fallback stays specified.

Two consequences came with it. The matcher had to take over city repair, which
the model had been doing for free (§12). And the lower confirm threshold for
narrowed queries had to go: 0.45 was calibrated when scores arrived near 1.0
because the model pre-corrected, and with the raw transcript "stane zkus" reaches
Stanescu at 0.579 and would have been read out as fact. One bar, 0.6, whatever
else the caller gave.

**Measured.** Three runs followed, not one: 37/40 on the first API run after the
change, 38/40 on the clean re-run, and 41/42 once ids were withheld. It is the
third that had `confirm_name` at **4** and `stane zkus` reaching the read-back
branch – the guard that had been dead at 0 was alive. The latest billed run, 44 cases on 14 September, scored **42/44
(95 %)** and is the current figure. It is also the run that measured the
emergency guard of §18, which had been merged before it.

That later run also showed the limit of this design, which §19 covers: the guard
is only as good as the string the model hands over, and in that run it handed
over a shorter one.

**The general lesson, which is the point of this entry.** An upstream component
silently improving its input can disable a downstream safety check, and every
test still passes, because the tests feed the downstream component directly. The
only thing that caught it was a counter of what actually happened per call.

---

## 16. Rechecking an apparently obvious conclusion

**Trigger.** A review questioned the statement that `clinic_name` is redundant
with `location`, because the committed 500-row test sample visibly contains many
different clinic names.

**What was checked.** The sample is deliberately a small stratified test fixture,
not the source for the data analysis. The claim was measured on the full 7029-row
interview snapshot: 42 distinct locations, 42 distinct clinic names, zero
locations with more than one clinic name, and zero clinic names appearing in more
than one location. In that snapshot, clinic and location form a bijection.

**What the claim does and does not mean.** It does not mean one clinic identifies
one doctor. Multiple doctors can share a clinic. It means that, for the purpose
of asking a caller one more question, `clinic_name` contributes no information
that `location` does not already contribute, and is less natural for a caller to
provide. It is deliberately excluded from `QUESTION_ATTRIBUTES`.

**Recheck rule.** This is a property of the current source snapshot, not a
universal property of hospital data. The ingest should continue to carry both
fields. If a future snapshot has a location with multiple clinic names or a
clinic name in multiple locations, rerun the ambiguity analysis and reconsider
whether clinic is useful as a disambiguation attribute.

---

## 17. A flag is not a permission

**Found by adversarial review, not by an incident.**

`find_doctors` returned an opaque id for every match, including results the store
had already marked `must_ask` (several plausible people) or `needs_confirmation`
(the name was not heard clearly). `get_doctor_contact` accepts any valid id and
returns a phone number, address and e-mail; it has no way to know whether the
identity was ever settled.

**Measured.** With an ambiguous surname the payload carried three usable ids, and
calling the contact tool with the first returned a real direct line:

```
must_ask=true  candidates=277
getDoctorContact(first id) → Carmen Dumitrescu · +40-297-788-262 · Strada Muncii 52
needs_confirmation=true
getDoctorContact(unconfirmed match) → Maria Vasilescu · +40-231-355-756
```

So the two flags the design leans on were advisory strings in a JSON blob. The
prompt said "ask first"; the payload said "here is everything you need to skip
that". One compliant-sounding caller – *"just give me the first one's number"* –
and a stranger gets someone's direct line.

**Decided.** The id is a capability, not a label. It is withheld from the
model-visible result while `must_ask` or `needs_confirmation` is true, and
released only once exactly one confident match remains. The store keeps its ids
for internal use; only the serialised payload changes. Nothing was added to the
prompt, because a prompt rule would have left the capability in the model's
hands – the point is that it no longer has one.

**The general form, and it is the fourth time this project has hit it.**
`must_ask` moved out of the prompt into the tool result; the confirm threshold
moved out of Czech prose into a constant; matching moved out of the model's
priors into the store. Each time the fix was to put the rule where the fact
lives. This one goes further: for a boundary that must not be crossed, it is not
enough to tell the model the answer – it has to not hold the means.

---

## 18. The prompt lost a coin toss on a head injury

**Found by a billed run, not by review.** Three emergency cases, one targeted run
after the post-model formatting clamp went in:

```
✅ Silnou bolest na hrudi a špatně se mi dýchá.        Volejte okamžitě 155.
✅ Potřebuji rychle vědět, jak zastavit krvácení.      Volejte okamžitě 155.   (model wrote 173 chars, clamped)
❌ Kamarád upadl. na hlavu … jestli s ním můžu hýbat.  114 chars, no 155 at all
```

The same head-injury utterance had been answered `Volejte okamžitě 155.` in the
full 42-case run minutes earlier. Nothing about it changed in between.

**Why.** The prompt contains two rules that both describe that sentence: acute
symptoms go to 155, and medical advice is refused with an offer to find a doctor.
"Můžu s ním hýbat?" is a request for advice about an acute injury, so it is
genuinely both, and the model picked one, then the other. The formatting clamp
cannot help here – it only fires once the model has already decided this is an
emergency, and this time it decided it was not.

**Decided.** The most dangerous utterances no longer reach the model.
`src/emergency.ts` recognises an explicit list of phrasings before any prompt is
built or any token billed, and returns exactly `Volejte okamžitě 155.` The
post-model clamp stays as the second layer, for emergencies the list does not
know and the model gets right.

**What keeps it from becoming triage.** It matches combinations, never bare
keywords: chest pain *with* breathing trouble, head *trauma* (a fall, a blow,
"úraz", "poranění" – never the word "hlava" alone), bleeding the caller is trying
to *stop*, present-tense stroke signs with past-tense framing excluded. Twelve
negative cases are pinned by tests, including "Děda měl loni mrtvici, hledám
neurologa", "Hledám doktora na bolesti hlavy" and "Hledám doktora, který léčí
krvácení z nosu"; two of them are also eval cases now, asserting that a search
still happens. Across the 42 utterances the suite held when the guard was
written, it fires on exactly the three emergency ones; the suite is 44 today.

**The asymmetry, stated on purpose.** A false positive tells someone who did not
need it to call 155. A false negative leaves someone bleeding on the line talking
to a directory. The guard is tuned towards firing, and every pattern that could
overreach has a test naming the query it must not steal.

**Verified live, in the 42/44 run of 14 September.** All three emergency cases
answered `Volejte okamžitě 155.` in 7 ms, 0 ms and 1 ms, against 3 to 22 seconds
for everything else, with the dispatch reasons in the run log; 41 of the 44 cases
were billed and the three emergencies cost nothing. Both negative guard cases
searched normally and neither said 155. That run measured this entry, it does not
predate it.

---

## 19. The verbatim rule is detectable, not enforceable

**Measured, in the final 44-case run.** The caller said "stane zkus"; the tool
call carried `surname: "stane"`. The token was dropped between the transcript and
the tool, and everything downstream behaved correctly on the input it was given:

```
surname="stane zkus"  candidates=0  needs_confirmation=true   top=Vlad Stanescu 0.579
surname="stane"       candidates=1  needs_confirmation=false  top=Vlad Stanescu 0.817
```

0.579 is below `CONFIRM_THRESHOLD`; 0.817 is above it. One missing word flipped
`needs_confirmation`, released the id (§17) and turned a required read-back into
a doctor named as fact. The same utterance reached the read-back in the two
previous runs with identical code, so this is variance in how the model fills
arguments, not a regression.

**Not an eval problem.** A read-only audit traced every field of every case:
only `utterance`/`turns` reach `runTurn` (`evals/run.ts:327`), and `note` plus
every `expect` key is consumed by `checkCase` after the turn completes
(`evals/run.ts:355`). Twelve of thirteen `args_include` values are exact literal
substrings of their utterance, `"stane zkus"` among them. The assertion described
the transcript correctly; the model did not.

**Why the obvious schema fix is not the fix.** Renaming the field to
`surname_as_heard`, with or without a second `surname_guess` slot, enforces
presence and never fidelity: `strict: true` and a `required` array cannot express
"must be a substring of what the caller said". A truncated value satisfies the
schema perfectly. The rename would cost a rewrite of all ten `args_include`
cases and a billed run to buy a better-named way to fail identically.

**Deferred design, for a pilot.** The component that holds the caller's words is
`runTurn`, and it already has them when it executes the tool. Pass the caller's
turns to the store as a side-channel the model cannot author, require the
model's span to appear token-aligned in one of them, extend it across whitespace
up to punctuation and up to any token claimed in another slot, and let the guard
use the **lower** of the two scores. On this utterance that is min(0.817, 0.579)
= 0.579, and the read-back fires despite the truncation. It does not stop the
model dropping the token; it makes dropping it harmless, which is the property a
renamed field does not buy at any price.

**Why it is not in this release.** It changes the confidence of real calls, so
its false-positive cost – extra read-backs on callers who were understood fine –
has to be measured offline against the 44 cases and the 43 transcripts, and then
once against the live model. Shipping it unmeasured tonight would repeat the
mistake this file keeps recording: a safety heuristic added on the strength of an
argument rather than a number. **It is designed, not implemented.**

---

## 20. A second reading of the code found four bugs the evals could not see

**Context.** A second model was pointed at the repository with the data and told
to check every number in it. It reported thirteen problems. Nine were real, one
was backwards, three were documentation drift. Everything below was reproduced
offline against the snapshot before anything was changed, because a review is a
claim, not a measurement.

**The emergency guard was dispatching directory queries.** `krvácení` plus
`nemůžu` anywhere in the same sentence counted as bleeding the caller cannot
stop, but "nemůžu" in Czech is nearly always about failing to reach someone:
"Nemůžu se dovolat paní doktorce, která mi léčí krvácení dásní" went to 155.
"Silné krvácení" matched inside an explicit search for a doctor who treats it.
The failure now has to attach to a stopping verb, and the heavy-bleeding wording
only counts outside a search framing. **22 of 22** on a positive/negative set,
and still exactly the same 3 fires across all 44 cases.

**Czech case endings were being read as different people.** This is the cost of
§15, and it was not visible when §15 was measured: once names go to the store
verbatim, the store gets "Alinu", not "Alina". Trigram Dice scores that 0.817,
under the 0.85 read-back bar, so the bot confirmed a name the caller had just
pronounced correctly. Under five letters it collapses – "Anu" and "Ana" share no
trigram at all and score **0.000**, under the floor, so the row was dropped and
ten Oanas in Oradea came back as "nemám". Of 118 case forms of the 30 given
names in the data, **21 failed**. Stripping the ending the way `normalizeSurname`
does is unsafe here, because -u, -i and -a are all real Romanian endings and
"Radu" would become "Rad", so instead the final vowel is swapped for each vowel
it could have replaced and the best candidate wins. Candidates are filtered
against the snapshot: "Oano" normalises to "ono" – the transliteration flattens
the diphthong – and its bare stem scored 0.50 against "Ionut", which had pushed
the candidate count for Oradea from 10 to 14. **118 of 118 now resolve.**

A test had pinned the 0.817 read-back as correct behaviour. It asserted the bug.

**Confirming a name had no exit.** The verbatim rule says pass the surname as it
was heard, so the search after "jo, to je ona" sent "Váselysku" again, scored it
the same, and got `needs_confirmation` back with the id still withheld. The loop
only ever ended when the model broke the verbatim rule. `find_doctors` now takes
`name_confirmed` – and clearing the flag alone would have been worse than the
deadlock: "Váselysku" scores under the confirm threshold, so nothing is a
confident candidate, `must_ask` stays false, and the turn would have released
the id of one arbitrary Vasilescu out of **291**. A confirmed name is instead
replaced by the name that was read back and the search runs again, which is what
the caller actually agreed to. Narrowed, that yields one id; unnarrowed, it
yields 291 candidates and the question "which city".

**Asking how fresh the data is ran a full scan.** `data_as_of` was readable only
off the end of a `find_doctors` result, so the bot searched 7029 rows with no
filter to read one date. It is in the system prompt now, built once and cached
so it stays byte-identical for prompt caching.

**What the review got wrong.** It reported that 40 of the 44 eval cases come
from the transcripts and four were hand-written. Matching each case's opening
against `stt-transcripts.txt` gives **42 and 2**, which is what the README says.
It also read a transcript line as claiming Laura Dumitrescu in Cluj is a
paediatrician; the line names no city, and the annotation was loose rather than
wrong. It is now explicit that "1 → found" holds within an already narrowed set.

**Still unmeasured.** None of this has seen the live model. It is offline work
against the snapshot and 254 tests.

## 21. "Indexy to řeší" was not true for the commonest query

**Claimed.** 0.1 to 0.5 ms per store query over 7029 rows, because the table is
indexed on surname, city and speciality and the fuzzy score only runs over what
the filter leaves.

**Measured.** True with a city or speciality, at 0.2 ms. False for a surname,
which is the commonest shape a caller gives: a surname is not compared by
equality, so it never reaches a `WHERE`, and the fuzzy score ran in JS over all
7029 rows for **7.6 to 8.3 ms** (p50 of 300). The surname index was never used.

**Decided.** The rows carry only 26 distinct surnames and 30 given names, so
scoring per row rebuilt the same trigram sets thousands of times: 7029 calls
cost 9.1 ms, the 26 distinct ones 0.66 ms. Memoising on the normalized column
took the surname-only query to **4.2 to 4.6 ms**, of which 3.4 ms is the
unfiltered `SELECT` itself. It changes nothing a caller can hear – it is three
orders of magnitude under one model call – and it is in because the claim in the
README had to become true or go, and because it paid for the extra given-name
candidates several times over.

---

## What is deliberately not done

- **Four-letter surnames** other than Ilie, which the `ije` rule fixed. They fail
  safe, into "not found, ask again", never onto a wrong doctor.
- **Caller verification before contact.** Confirmed in the exercise brief: the
  list is a public directory, the "golden pages", so anyone may have a contact.
  Nothing to build, and not an open question.
- **Shadow mode, monitoring, real STT/TTS, rate limiting.** Pilot work.
