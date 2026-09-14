# Decision log

What was measured, what it showed, and what was decided because of it. Entries
that record a *rejected* idea matter as much as the accepted ones — several
plausible changes turned out to buy nothing, and that is only visible because
they were measured before being built.

Numbers come from the full 7029-row snapshot unless stated otherwise.

---

## 1. The endpoint is never called during a call

**Question.** The hospital exposes one endpoint returning the whole list, taking
~10 minutes. Can it be called live?

**Measured.** No measurement needed — 10 minutes against a phone call answers it.

**Decided.** Pull a snapshot on a schedule, serve every call from local SQLite.
A full-scan lookup over 7029 rows costs **9.7 ms**, so there is no case for
querying anything remote at call time.

---

## 2. Snapshot replacement is all-or-nothing

**Question.** How to replace a snapshot without a window where the bot answers
from half a table?

**Decided.** Stage into `doctors_new`, then `DROP` + `RENAME` + rebuild indexes +
update `meta` inside one `db.transaction(...)`. SQLite makes DDL transactional,
so a throw anywhere rolls back and the old table stays live.

**Guards.** Abort *before* the swap if the new snapshot has fewer than 70% of the
previous row count, or if more than 5% of rows fail Zod validation. A bad
snapshot then costs freshness, not service — and the bot can still say how old
its data is.

---

## 3. Doctor identity is not modelled — and the obvious id is unsafe

**Question.** How to identify a row across snapshots?

**Measured.** `last_name|first_name|clinic_name` collides on **669 of 7029 rows**
(616 groups). Every one of those groups carries **different phone numbers and
addresses** — they are different people, or the same person at different
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

---

## 5. Three fields in the data are traps

**Measured.**

- **`clinic_name` is a bijection with `location`** — 42 clinics, 42 cities,
  `Clinica {city} Care`. Zero cities with two clinics, zero clinics in two cities.
- **`postal_code` is noise** — 173 distinct postal codes inside Cluj-Napoca alone.
- **`email` is shared by 616 pairs of different doctors**, because it derives from
  name + clinic. `phone` is the only genuinely unique field (7029/7029).

**Decided.** `clinic_name` is out of the disambiguation set — asking which clinic
asks which city in a word no caller would use. It stays in the tool payload so
the bot can say it once one doctor remains. `postal_code` is never used for
location. Contacts carry `email_shared`, and the bot says the address belongs to
the clinic while the phone is the direct line.

---

## 6. Czech feminine surnames: correctness was fine, confidence was not

**Question.** A caller says "doktorka Munteanuová"; the data says "Munteanu".

**Measured.** Across all 26 surnames × 3 declined forms (78 utterances), trigram
overlap already resolved **every one** to the right surname. What it did not do
was score them confidently: mean **0.837**, and **24 of 78** landed under 0.8.
`Rusuová` against `Rusu` scored 0.721.

**Decided.** Strip the suffix — mean goes to **1.000**, nothing under 0.8. This
matters because the confirm-the-name branch is score-gated: the bot was asking
"did I hear you right?" about names it had heard perfectly.

**Constraint discovered.** It cannot live in the general `normalize()`, because
the city `Craiova` would become `kraj`. Hence a separate `normalizeSurname()`
used for surnames only, with a test asserting `normalize("Craiova")` is untouched.

---

## 7. The transliteration table is not overfitted, and one gap was not a limit

**Question.** Was the table tuned to the handful of names used to build it?

**Measured.** Five surnames never used in its construction: Draghomír→Dragomir
0.765, Ijakob→Iacob 0.857, Rusů→Rusu 1.000, Stánová→Stan 0.721, Jonesku→Ionescu
0.800. All five resolve, worst 0.72.

**Separately.** `Ilije` against `Ilie` scored **0.000** — no shared trigram. This
looked like a hard limit of trigrams on four-letter surnames. It was not: the
table had no rule for the glide a Czech ear inserts. Adding `["ije","je"]` and
`["ija","ja"]` took it to **1.000**, and `Dijakonu`→`Diaconu` from 0.727 to 1.000,
with nothing regressing. A phonetic fallback was planned and turned out to be
unnecessary.

**A rule with a cost.** `["ya","a"]` resolves `Nyagu`→`Neagu` at 1.000 — correct,
since that is how a Czech writes Neagu. It also removed the only low-confidence
fixture the confirmation path was tested with. Accepted anyway; `Nyštor`→`Nistor`
at 0.50 became the confirm fixture.

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
  reliable — it ignored `needs_confirmation` and treated a low-confidence hit as
  not-found in two of three runs.
- **Effort is not the lever.** 5980 vs 5968 ms.
- **Thinking is not the lever.** `output_tokens_details.thinking_tokens` came back
  **0, 0, 0, 0, 7, 19**. Disabling thinking entirely changed nothing.
- **Payload trim** (dropping contact details, hours, rating and seniority from
  search results) moved 7309 → 7132 ms. Kept, small but free.
- **Prompt caching**: interleaved A/B rounds went A-better, A-better, B-better.
  Inconclusive on latency; within-condition spread (6.1–10.1 s) swamps it. Kept
  for **cost**, not speed — 1650 tokens read from cache on every call, so two
  calls per turn cost ~1.35× the prefix instead of 2×.

**What the number actually is.** Time to first token on the spoken call is
**1.5–1.9 s** against ~7 s end-to-end. Most of the wait is generating text nobody
needs to wait through.

**Decided.** Stream the spoken call and record TTFT. Return the model's filler
("Moment, podívám se") separately as `preamble` instead of gluing it to the
answer, so a voice runtime can play it during the search. The tool-decision call,
which is never spoken, stays non-streaming.

**Found while instrumenting.** The filler was sometimes **English** — *"I'll look
her up right away."* — and was being spoken after the search rather than during
it. Fixed by separating it and adding an explicit Czech-only rule.

---

## 9. Test data: coverage has to be constructed

**Measured.** A positional slice of the snapshot loses whole categories — a cut
from the middle missed **Psychiatry entirely**, the speciality in the flagship
two-Dumitrescu case, plus 20 of 42 towns. A lead cut missed 9 towns.

**Decided.** `make-sample.ts` builds a 500-row slice that covers every speciality,
location, language and surname, pins the ambiguous groups, the id-collision
groups and the irreducible pairs, then stride-fills to keep the distribution.
Deterministic, regenerable, never hand-edited. Tests read it, so a fresh clone
runs green without the 3 MB snapshot.

---

## 10. Searching: a wide net is right only while the matcher is unsure

**Measured.** Searching "Dumitresku" returned **565 plausible candidates** — 277
Dumitrescu at 1.000 *and* 288 Dumitru at 0.765, which the fuzzy matcher admits on
purpose.

**Decided.** Once any candidate reaches 0.95, drop everything under 0.85. 565
becomes **277**. Below that trigger the wide net stays, because `Nyštor` must
still reach `Nistor` at 0.50.

**Second decision.** Reading out three arbitrary names from hundreds is not an
answer. The store computes which single question splits the remaining candidates
best — smallest worst-case bucket — and returns it with its options. Asking which
city removes **544 of 565**. Surname is checked first and outside that metric: a
metric rewarding many distinct values would hand the question to city (42 values)
every time, when "Dumitrescu, or Dumitru?" is plainly the first thing to ask.

---

## 11. Two bugs found by asking what the model actually receives

**Unresolved terms were silently dropped.** A city the matcher could not place
fell out of the filter, so "kardiolog v Brně" returned three cardiologists in
Romania and the model was never told why. Terms that do not resolve now return no
matches and name themselves in `unresolved`.

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
set — but only when something clears the threshold, because below it the best
guess is the name the bot reads back to confirm.

---

## 12. Real STT transcripts: the offline measurement was misleading

**Question.** How does the system handle verbatim Czech dictation?

**Measured twice.** Feeding the raw transcript text straight to the matcher gave
31 match / 7 miss. Running the same 43 transcripts through the agent gave
19 pass / 14 fail — **and they fail on almost entirely different things**.

**Why.** The model repairs most STT damage before the tool sees it:

```
STT wrote "Kůži"       → model passed "Kluž"      → Cluj-Napoca
STT wrote "ploj testi" → model passed "Ploješť"   → Ploiesti
STT wrote "Santumare"  → model passed "Satu Mare" → found Andrei Rusu 1.00
STT wrote "Rusové"     → model passed "Rusu"      → 1.000
```

**Decided.** Do not build the matcher fixes the offline run appeared to justify.
Space-stripped city matching is measurably safe (zero false positives across nine
non-network cities, all 42 cities still self-resolve) and would lift `Santumare`
from 0.286 to 0.615 — and would fix **zero** real transcripts, because the model
already passes `Satu Mare`. A `y→i` fold was measured at **0.436 → 0.436**: worth
nothing, because the mismatch is `e`/`i`.

The real failures are elsewhere — confirming names that are not in the shortlist,
naming one doctor out of 186, and STT noise words derailing a lookup into a
refusal. Those are where effort goes.

---

## What is deliberately not done

- **Four-letter surnames** other than the two fixed by the table rules. They fail
  safe, into "not found, ask again", never onto a wrong doctor.
- **Caller verification before contact.** The brief describes a public directory,
  so contacts are public. This is an assumption to confirm, not a thing to build.
- **Shadow mode, monitoring, real STT/TTS, rate limiting.** Pilot work.
