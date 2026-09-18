# Doctor directory bot

A voice bot for a hospital network's phone line: a patient calls, says a doctor's
name or a speciality and a city, and the bot finds them and reads out the
contact. An interview exercise for Wonderful. The hospital gives us a single
endpoint that returns the whole list and takes about ten minutes to answer. No
webhooks, no incremental changes, nothing else.

What if a doctor changes their name? Nothing happens, because nothing of ours is
attached to a doctor and I replace the snapshot wholesale. It would not work by
name anyway: of 780 full names, not one belongs to a single person.

Assumptions, open questions and the definition of success are in
[DISCOVERY.md](DISCOVERY.md); the measurements and the decisions that came out of
them are in [DECISIONS.md](DECISIONS.md).

## Goal and outcome

| what should hold | how it turned out |
|---|---|
| the endpoint is never called during a call | **done**, a call reads only the local SQLite snapshot |
| when several candidates fit, the bot never names one | **done**, `must_ask` lives in the tool's data, not in the prompt |
| no contact details until identity is settled | **done structurally**, the model is not given an `id` for an unsettled result, so it has nothing to look the contact up with; verified by two pressure cases |
| an acute condition always gets „Volejte okamžitě 155." | **done deterministically**, recognised phrasings are decided before the model; 3/3 in the last run, at 7, 0 and 1 ms |
| behaviour on real transcripts | **42/44 (95 %)** in the last billed run |
| what the caller said reaches the tool verbatim | **open**, the model once shortened `stane zkus` to `stane` and bypassed the confirmation |
| an answer within 1.5 s of the end of the sentence | **not done**, first token at 2.1 s (max 7.0 s), a whole turn averages 6.7 s |
| 95 % of calls handled without a human | **not measurable without traffic**, containment only comes out of shadow mode |

Since that run I have re-read the repository against the data and fixed four
behavioural bugs: the emergency guard sent ordinary queries containing the word
"krvácení" to 155, Czech case endings on given names read as a different person,
confirming a name had no exit, and asking how current the data is triggered a
search across all 7029 rows. All of it is fixed and verified offline against the
snapshot and 274 tests, but **none of it has been run against the live model**,
so the 42/44 above predates the fixes. Details in
[DECISIONS.md](DECISIONS.md) §20 and §21.

## Three-minute summary

**What I built.** A voice directory bot over a hospital endpoint that takes ten
minutes to return the whole list. It never calls that endpoint during a call: a
scheduled ingest validates the snapshot, swaps it atomically into SQLite, and the
agent gets two read-only tools over it, search and contact.

**What the data decided.** Across 7029 rows in the full snapshot, not one full
name is unique. That killed my original idea of diffing snapshots and tracking a
doctor's identity: nothing is attached to a doctor, so I replace the snapshot
whole. Name, city and speciality together separate 6969 of the 7029 rows; when
more than one candidate is left, the store picks the question that rules out the
most.

**How I tested it.** I dictated 43 real Czech transcripts into macOS dictation,
including mangled Romanian names, chopped-up city names, Czech mixed with English
and the usual spoken filler. 42 of the 44 behavioural eval cases came out of
those; the other two I wrote by hand as negative boundaries for the emergency
guard. I ran them through the real tool loop, not just unit tests; the history,
the raw results and the cause of every failure are in `evals/RUNS.md`.

**How it went.** The last full run finished at 42/44, so 95 %. It is not the 95 %
from discovery though: that goal is about the share of calls handled without a
human, whereas the eval set is deliberately a collection of hard cases, not a
sample of traffic. Until shadow mode runs alongside reception, the eval score is
a proxy and I have no way to measure containment.

**Where the limit is.** One failure is a checker bug; the other is more serious.
The model once shortened `stane zkus` to `stane` before the tool saw it and
bypassed the name confirmation. The evals caught it, but the verbatim rule is
still only in the prompt. The next step for a pilot is to keep the raw span of
the transcript out of the model and compute confidence pessimistically. It is not
done.

## Where my part ends

![Three parts: the hospital, the part implemented in this repo, the Wonderful platform](docs/ownership-map.svg)

In words, in case the image does not load: **the hospital** is a black box with a
single `GET /doctors` (the whole JSON, around ten minutes) and will build nothing
further on its side; `mock-hospital-api` stands in for it here. **The implemented
part** is this repository: a scheduled ingest into a SQLite snapshot (validation,
guards, atomic swap), two tools `find_doctors` and `get_doctor_contact` (fuzzy
search, name confirmation, `best_question`), and over them the agent prompt and
the evals, which check behaviour rather than wording. **The Wonderful platform**
supplies telephony and SIP, STT and TTS, the orchestrator and a review queue with
metrics; the CLI stands in for it here.

The ingest is a scheduled job, the two tools are a Skill, the prompt is agent
configuration and the evals are the check on it. I return the bridging sentence
("Moment, podívám se") separately from the answer so the runtime can play it
during the tool call; that is where perceived latency hides. How often to fetch
is a line in a cron file and a question for the hospital, not a constant in the
code.

## One call

A verbatim transcript of a run through the agent on 15 September 2026, from 277
candidates down to one in three turns. The counts on the right are what the tool
returned on that turn.

```
👤 Hledám doktora Dumitresku                         277 kandidátů
🤖 Doktorů Dumitrescu mám víc. V jakém městě ordinuje — například
   v Mediaši, v Brašově, v Kluži, nebo v Romanu?

👤 V Kluži                                            11 kandidátů
🤖 V Kluži jich mám jedenáct. Jaké má křestní jméno — například Alina,
   Andrei, Bogdan, nebo Cristina?

👤 Alinu                                               1 kandidát
🤖 Mám ji: doktorka Alina Dumitrescu, psychiatrie, Clinica Cluj-Napoca
   Care. Přejete si kontakt nebo ordinační hodiny?
```

With 277 candidates the bot does not ask about the surname they all share but
about the city, because that rules out the most. The "například" in the question
means there are more options than the four named, 42 cities in fact. It reads out
neither phone nor address until the caller asks; on the last turn it only asks
whether they want them.

## Latency

In discovery I set myself a goal of **under 1.5 s** from the end of the sentence
to the start of the answer. The last run: first token at **2.1 s**, **7.0 s** in
the worst case. So the goal is missed, and it is the only number from discovery
that did not come out.

The runner used to measure a whole case rather than a turn, and 11 of the 44
cases are conversations of two or three turns. Its average of 8.9 s was therefore
not the time for one answer, which confused me for a while. Recomputed from the
log of the last run, with no new API call:

| unit | average | max | sample |
|---|---:|---:|---:|
| **turn** (what the caller waits for) | **6.7 s** | 13.4 s | 58 turns |
| of which single-turn cases | 6.9 s | 13.4 s | 33 cases |
| of which multi-turn, per turn | 6.4 s | 8.3 s | 11 cases / 25 turns |
| **call** (the whole case) | 8.9 s | 22.2 s | 44 cases |
| **first token** (TTFT) | 2.1 s | 7.0 s | 37 streamed |

The three emergency cases average 7, 0 and 1 ms, because the pre-model guard
handles them and they never reach the API. A single-turn case that really does
call the API comes out at **7.6 s**. The runner now prints all three units
separately.

The time is entirely in two model calls per turn: the first picks a tool, the
second turns the result into a sentence. The SQLite query between them is a
rounding error against that, but not as small as this file used to claim. With a
city or a speciality in the filter it runs in **0.2 ms**, because the table is
indexed on both. With a surname alone there is no `WHERE` at all, because a
surname is not compared by equality but scored fuzzily in JS across all 7029
rows. That is the commonest shape of query and it cost **6.9 to 8.3 ms**;
memoising the score on the 26 distinct surnames brought it to **4.2 to 4.6 ms**,
and the remaining 3.4 ms is the `SELECT` itself. It is still a thousandth of one
model call, so the speeding up belongs elsewhere, but "the indexes handle it" was
not true.

I measured four suspects and three of them are not it (details in
[DECISIONS.md](DECISIONS.md) §8): a different model (Sonnet is the same speed and
less reliable; Haiku rejected the `effort` parameter outright, so its 16.5 s is
the SDK retrying rather than Haiku generating, which means I do not know how fast
Haiku is), `effort` (5980 against 5968 ms), thinking (the model produced 0 to 19
tokens of it) and the prompt cache, whose effect disappeared into the variance. A
smaller payload took 7309 → 7132 ms, almost nothing, but free.

What I would try next, most promising first. I have measured none of it, so these
are ideas, not solutions.

1. **Stream into TTS.** The first token arrives at 2.1 s, but today the caller
   waits for the whole sentence. Speaking it as it arrives cuts perceived latency
   to that first token without changing anything in the agent. The agent already
   streams and measures TTFT; the runtime is what is missing.
2. **Play the bridging sentence during the search.** The agent returns it
   separately as `preamble` ("Moment, podívám se") precisely so the runtime can
   play it while the tool runs. Done on my side, also waiting on a runtime.
3. **One call instead of two.** The turn could open by searching on whatever the
   caller said and leave the model only to phrase the sentence. It overlaps with
   what is needed anyway for verbatim pass-through (below), so one change could
   settle two things.
4. **Shorter answers.** Generation time grows with the length of the text, and the
   bot sometimes adds a sentence. `LOG_TIMING=1` already prints input and output
   tokens per call, so it is possible to find out how much of the time is the
   second call's output before cutting anything.

Not worth trying, because it has been measured: a smaller model, `effort`,
thinking, the prompt cache and the database.

## What the full snapshot showed

The numbers below come from the full snapshot in the exercise; the repository
carries only a stratified 500-row sample for reproducible tests.

7029 doctors across 26 surnames and 30 given names. **Not one of the 780 full
names belongs to a single person**, the commonest is shared by twenty, and that
is why a lookup never ends on a name alone. Name, city and speciality together
uniquely separate 6969 of the 7029 rows (99.1 %); the remaining 60 rows are 30
pairs differing only by phone, address and languages, and for those the bot asks
about language and says why.

Four fields look usable and are not:

- **The clinic is the city.** 42 clinics, 42 cities, "Clinica {city} Care", one
  clinic per city exactly. Asking about the clinic is asking about the city in
  worse words, which is why it is not among the disambiguating questions.
- **The county is the city one floor up.** None of the 42 cities sits in two
  counties and there are only 34 counties (Cluj covers both Cluj-Napoca and
  Turda), so it cuts less than the city and adds nothing after it.
- **The email is derived from the name and the clinic**, so 1285 rows share a
  mailbox across 616 groups. The contact carries `email_shared` and the bot says
  the direct route is the phone.
- **The postcode is random**, 173 of them in Cluj alone.

The only unique field is the phone number, 7029 out of 7029.

### How many candidates are left

The bot decides what to ask from this table. "Groups" is the number of distinct
combinations, "average" the number of doctors per group.

| query | groups | average candidates | max | unique rows |
|---|---:|---:|---:|---:|
| surname | 26 | 270.3 | 291 | 0 |
| surname + language | 182 | 77.3 | 98 | 0 |
| surname + speciality | 520 | 13.5 | 23 | 0 |
| surname + given name | 780 | 9.0 | 20 | 0 |
| surname + city | 1091 | 6.4 | 16 | 13 (0.2 %) |
| city + speciality (no name) | 840 | 8.4 | 18 | 0 |
| given + surname + city | 6360 | 1.1 | 4 | 5744 (81.7 %) |
| given + surname + city + speciality | 6999 | 1.0 | 2 | 6969 (99.1 %) |

A surname on its own identifies nobody, in none of the 7029 rows, so the bot can
never read out a contact after the first turn. The city cuts the most, from 270
candidates to 6.4, which is why the first question is about the city. Language is
nearly useless as a filter, 270 down to 77, and is therefore last in the order.
Even a name with a city is not always enough: 616 such groups hold more than one
row, usually with a different speciality and a different phone. It is the same
division that shares an email mailbox.

The order of questions in the code is city, speciality, given name, language. A
given name cuts slightly better than a speciality (9.0 against 13.5), but
speciality goes first because a caller can nearly always answer it. That is an
assumption from discovery, not a measurement; in a pilot the share of questions
answered with "I don't know" would settle it.

### Frequencies

| field | values | commonest | rarest | median per value |
|---|---:|---|---|---:|
| surname | 26 | Vasilescu 291 | Nistor 248 | 272 |
| given name | 30 | Florin 264 | Alexandru 209 | 232 |
| city | 42 | Galati 196 | Drobeta-Turnu Severin 141 | 164 |
| speciality | 20 | Infectious Diseases 381 | Neurology 325 | 350 |
| language | 7 | Romanian 2033 | Italian 1979 | 2016 |

The six commonest and six rarest of those 26 surnames:

| commonest | doctors | rarest | doctors |
|---|---:|---|---:|
| Vasilescu | 291 | Nistor | 248 |
| Dumitru | 288 | Stan | 250 |
| Chivu | 286 | Stancu | 252 |
| Stanescu | 286 | Marin | 252 |
| Rusu | 283 | Matei | 255 |
| Dobre | 283 | Enache | 256 |

What to watch out for. The distribution is nearly flat, 17 % between the
commonest and the rarest surname, so no query is an "easy" one and a measurement
on a sample holds elsewhere too. The dangerous ones are pairs that differ by a
syllable and both exist in the data: Stan, Stancu and Stanescu, Dumitru and
Dumitrescu, Popa and Popescu. The matcher cannot tell a mishearing between them
apart, both names are real, and that is why the tool returns
`surname_substituted`: the caller said a surname that is in the list, the hit
carries a different one, the bot has to say so out loud and must not slip it in.
Short surnames have it worst, they have few trigrams.

Two thirds of the doctors (66 %) speak several languages, which is the second
reason language is the last question: it cuts little, and "speaks Hungarian" does
not rule the others out anyway.

## Decisions

**1. The hospital endpoint is never called during a call.** It answers in
minutes, so the ingest runs on a schedule outside the call and the call reads
only the local SQLite snapshot. How often it fetches is a line in a cron file and
a question for the hospital, not a constant in the code.

**2. The snapshot is replaced whole and atomically, in one transaction.** `DROP`,
`RENAME`, the indexes and `meta` all sit inside a single `db.transaction(...)`.
If validation fails, or the row count drops below 70 % of the previous one, the
swap does not happen, the old table stays, and the bot can say how old the data
is.

**3. Doctor identity is not modelled.** 616 groups share an email, and some
candidate groups share a name and a clinic while differing in speciality, phone
or address. So the `id` is only a per-snapshot hash, it changes with the data,
and nothing is attached to it.

**4. Surnames get their own normalisation.** The Czech `-ová` did not cost
correctness but confidence: "Rusuová" matched "Rusu" at only 0.721, under the
threshold, so the bot would ask "did I hear that right?" about a name it had
heard perfectly. Stripping the suffix lifts 24 of 78 declined forms from below
0.8 to 1.000. It must not go into the general `normalize()`, because the city
`Craiova` would turn into `krai`.

**5. The fuzzy search is built against Czech STT**, not against typos: trigram
Dice over a transliteration table, a bonus for the first three letters matching,
top 3 candidates. Above that the bot asks; below a score of 0.6 it reads the name
back. One caveat still stands: that threshold only sees what the model hands it,
and the last run showed that need not be what the caller said (below).

**6. Specialities and cities are given in Czech** through a table of synonyms and
exonyms (kardiolog → Cardiology, Kluž → Cluj-Napoca). Without a surname, results
are ordered by rating rather than by name score.

**7. Acute symptoms take precedence over everything else.** Chest pain with
breathlessness, a fresh head injury, bleeding the caller cannot stop,
unconsciousness or signs of a stroke end in a single sentence, „Volejte okamžitě
155." No tool call, no doctor search, nothing else.

It is not merely a prompt instruction, which I learned the hard way once.
Recognised phrasings are decided **before** the model (`src/emergency.ts`) and
return a fixed sentence without a single token; the model is the second layer for
what the list does not know, and behind it a clamp shortens its emergency answer
to the same sentence. The list targets combinations rather than words, so "Děda
měl loni mrtvici, hledám neurologa" and "krvácení z nosu" still lead to a search.
A false positive is one "call 155", a false negative is somebody bleeding while
talking to a directory, so the threshold leans towards the false alarms.
Non-acute trouble leads to an offer of a speciality: "Bolest hlavy neumím
posoudit ani léčit. Můžu vám ale najít neurologa nebo praktického lékaře."

**8. Contact details only on request.** Neither phone nor address goes into an
answer by itself; they sit behind a separate tool that is called only once the
caller asks. That holds for the first turn too: if the caller asked straight out
for a number or an address and exactly one doctor came out, they get it
immediately, as in the "Rusu Andreje ze Santumare" case.

**9. An empty answer is a bug, not an edge case.** The loop ceiling, a refusal
from the model and empty text all end in a fixed Czech sentence that tells the
caller what to do next. The evals always count an empty answer as a failure. Name
detection in out-of-scope cases goes through word boundaries rather than
`includes`, or the surname "Stan" would be found inside the word "stanovit" and
the case would fail for the wrong reason.

**10. The evals have guards of their own.** The runner refuses to start if any
case has an empty utterance, and it validates `behaviour` values against a table
and rejects unknown `expect` keys. All of it came out of mistakes while building:
two cases I believed existed were missing, one carried `behaviour: null` which
would have crashed the run, and a typo in an `expect` key used to be silent, so
the assertion never ran while the case claimed to check something.

**11. The data sample is stratified, not random.** Coverage has to be
constructed: a positional slice from the middle of the file lost Psychiatry, and
with it the flagship ambiguous case.

**12. Short surnames have few trigrams**, so they survive a mishearing less well.
"Ilije" against "Ilie" scored 0.000 until it turned out that was not a limit of
trigrams but a missing row in the transliteration table; today it is 1.000. What
does not get fixed falls safely into not_found, so into a question rather than
onto the wrong doctor.

**13. Czech case endings are handled in the store, not in the prompt.** Since
names go to the tool verbatim, the store receives "Alinu", not "Alina". Trigrams
score that 0.817, under the bar for a read-back, so the bot kept confirming a
name the caller had just pronounced correctly. For shorter names it is worse:
"Anu" and "Ana" share no trigram at all, score 0.000, the row falls under the
floor and ten Oanas in Oradea come back as "nemám". The ending cannot be cut off
the way it is for surnames, because -u, -i and -a are all real Romanian endings
and "Radu" would be left as "Rad". The last vowel is therefore swapped for every
vowel it could have replaced and the best candidate wins. Of 118 case forms of
the 30 given names in the data, 21 used to fail; now none does.

**14. Confirming a name has to have a way out.** Verbatim pass-through means that
after "jo, to je ona" the tool gets "Váselysku" again, scores it the same, asks
the same question, and the `id` stays withheld. The only way out was to break the
rule. `find_doctors` therefore takes `name_confirmed`, and simply clearing the
flag would have been worse than the deadlock: "Váselysku" is under the confidence
threshold, so no candidate counts as confident, `must_ask` stays false, and the
turn would hand out the `id` of one of 291 Vasilescus. Instead the confirmed name
is replaced by the one the bot read back, and the search runs again.

**15. An exact match wins when there is one.** Ten pairs of distinct given names
in the data clear the 0.45 floor: Ana reaches Diana at 0.500, Maria reaches Daria
at 0.667. A search for a name the snapshot knows was counting other people as
candidates and could ask a narrowing question about nobody. Only when an exact
row survives, though: where nothing matches exactly, the near miss is the most
useful thing the store has, and a caller whose "Diana" was heard as "Ana" should
reach her and have the name read back rather than be told the network has nobody.

**16. Deliberately missing:** shadow mode, monitoring, real STT/TTS, rate
limiting, and the edge cases only a pilot will bring.

## What the real transcripts taught me

I ran 43 real macOS dictation transcripts through the matcher offline and then
through the agent. Offline it looked like 31 of 38; live, 14 of 43 failed, and on
entirely different things. The reason was that the model repaired the damage from
the transcript before the tool ever saw it: it sent "Kůži" as "Kluž" and
"Santumare" as "Satu Mare".

For a while I took that as good news and left the matcher alone. That was a
mistake. The model is not repairing those names from the data, which it cannot
see, but from what it knows about Romanian names from training, so it is guessing
from priors. That had two consequences. When it guessed right, a clean name with
a score of 1.0 arrived at the store and the "did I hear that right?" branch never
fired once (`confirm_name 0` across all 38 cases). If it had guessed wrong and
repaired to a different real Romanian surname, the store would have taken that as
certainty and the bot would have named the wrong doctor without asking, and the
evals would not have shown it, because across those 38 cases it guessed right
every time.

**The current design is therefore the opposite: the model passes the surname, the
given name and the city through exactly as they were said, and the store owns the
searching**, because it is the only thing that can see which names are in the
data. The city repairs the model had been doing for free now have to be the
matcher's job: cities are compared without spaces, with a lower threshold than
specialities, and the synonyms are lifted from real transcripts (`kuzi`,
`ploj testi`, `santumare`, `tam je svar`, `botan siker`) rather than invented.
Offline across the 43 transcripts that moved 31/7 to 35/3, with no false positive
among nine towns outside the network and all 42 real cities still resolving to
themselves.

The same change killed the lower threshold for confirming a name. It had been set
at 0.45, back when names arrived at the store already repaired and scores sat
near one. With the raw transcript, "stane zkus" comes through at 0.579 and would
have been read out as fact without a confirmation. There is one bar now, 0.6,
whatever else the caller gave.

**The last billed run: 42/44 (95 %).** What holds in code rather than only in the
prompt is in the table at the top. What holds only halfway is more interesting.

**An open safety problem that run found.** The model can drop a word from a spoken
surname when it calls the tool. "stane zkus" arrived at the store as "stane": the
score went 0.579 → 0.817, `needs_confirmation` flipped to false, and the bot read
out Vlad Stanescu as fact instead of asking. The same sentence went through the
confirmation branch in the two previous runs, so this is not a code regression
but variance in how the model fills arguments.

The verbatim rule is in the prompt and in an eval assertion (`args_include`), so
it gets caught, but nothing prevents it. The read-back safeguard currently rests
on the model not truncating the transcript, and that is not a guarantee.

**The next step for a pilot:** keep the raw span of the transcript out of the
model and compute confidence pessimistically, so that a name the model shortens
or invents forces a confirmation.

The live run forced three other things earlier. The bot was confirming names it
had not found at all: a patient who said Popescu was offered Dumitrescu at 0.31,
and there is no candidate under 0.40 now. The "do not name one of many" rule was
only in the prompt and the model broke it with 186 candidates, so `must_ask`
lives in the data now. And a transcript with "restaurace" instead of "doktorka"
knocked the search into a refusal.

## Tests and evals

```
$ npm run typecheck && npm test
  Test Files  5 passed (5)
       Tests  274 passed (274)
   Duration  268ms
```

The last measured billed run:

```
$ npm run evals          # 44 cases, 14 September 2026
42/44 passed — 95% (threshold 80%) · conversation ms avg 8878, max 22206
                                    · TTFT avg 2105 ms, max 7048 ms (37 streamed)

outcome breakdown (what happened, not what was expected):
  emergency            3
  contact              6
  confirm_name         3
  ask_clarification   21
  not_found            6
  out_of_scope         2
  found                3
  other                0
```

The latency in that output is per call. Per turn, which is what the caller
actually waits through, it comes to **6.7 s** (58 turns), and the first token
arrives at **2.1 s**; one turn is two API calls, one to pick the tool and one to
build the sentence. The runner now prints `turn ms`, `conversation ms` and `TTFT`
as three separate lines.

Two red cases. The first is a checker bug: the bot asked "Řekněte mi prosím
jméno", which is a valid question, but the `ask_clarification` pattern recognises
four shapes and the imperative is not among them. The second is the one described
above, "stane zkus" arriving as "stane". Older runs, and the distinction between
a fault in the agent, the matcher, the case or the checker, are in
[evals/RUNS.md](evals/RUNS.md), which is the source of truth for every number.

Those numbers are not from the same set: 43 are raw transcripts for the matcher,
38 was the old agent eval, and 44 are today's behavioural scenarios.

## Setup

You need Node 20 or newer (developed on 22) and an Anthropic API key.

```bash
npm install
cp .env.example .env      # and fill in ANTHROPIC_API_KEY
```

The full snapshot from the exercise is not in the repository; what is committed
is a 500-row sample (`data/data-sample.json`), and everything including the tests
runs on it. If the full snapshot is missing from `data/full-snapshot/`,
`npm run mock-api` falls back to the sample on its own and says so.

The full snapshot stays local and is in `.gitignore`. Only the stratified 500-row
sample is in the repository, so the project can be cloned, run and tested without
another file. Numbers in `DECISIONS.md` marked as measured over the full snapshot
are results over the interview fixture, not over the committed sample.

Order for a first run: `ingest` needs `mock-api` running, and `doctor` and
`evals` need a populated database:

```bash
npm run mock-api                          # terminal 1, keeps running
npm run ingest                            # terminal 2, once
npm run doctor -- "Hledám doktora Dumitresku"
```

`npm test` and `npm run typecheck` run on their own and need neither the database
nor a key.

## Commands

| Command | What it does |
|---|---|
| `npm run mock-api` | Mock of the hospital endpoint on `:4010`, answers after `SLOW_MS` (default 3000, the real one around 600000). |
| `npm run ingest` | Fetches the snapshot, validates it with Zod, swaps it atomically into `db/doctors.sqlite`; guards against a drop in row count and against invalid rows. |
| `npm run doctor -- "query"` | One query through the agent. Interactive mode without an argument. |
| `npm test` | Vitest: the matcher (STT manglings, synonyms, negative cases) plus the ingest guards. |
| `npm run evals` | Replays `evals/cases.json` through the agent, checks both tool calls and the answer, fails under 80 %. Calls the API, so it costs money. |
| `npm run evals -- --validate-only` | Only checks `cases.json` (`behaviour` values, tool names, unknown `expect` keys, `turn_behaviours` lengths) and exits. No API calls. |
| `npm run typecheck` | `tsc --noEmit`. |

## Deliberately missing

The evals are mostly single-turn; eleven are multi-turn and three of those have
three turns. They cover what matters, the narrowing questions and contact details
only on request.

Latency is measured without STT and TTS, and it misses the 1.5 s goal both per
turn (6.7 s) and to the first token (2.1 s). Details above.

There is no LangGraph here; interruptions in the flow (name confirmation, a
mandatory question) are handled with flags in the tool result. In a graph that
would be an interrupt with a checkpoint, and it is the first candidate for a
rewrite.

Shadow mode and monitoring are missing; both belong with a pilot.
