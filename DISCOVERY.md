# discovery - notes

Engineering discovery log for this exercise: what I learned about the brief, what
I filled in myself, and what stayed open. Measured decisions and run history live
elsewhere, in [DECISIONS.md](DECISIONS.md) and [evals/RUNS.md](evals/RUNS.md).

None of this is confirmed with the hospital. It is how I understood the brief.
Where I filled something in, it is written down as an assumption.

## the brief, as I understood it

- hospital network, voice bot, a patient calls looking for a doctor
- it is essentially a public directory, the "golden pages" - contact details are
  public, so I am not verifying the caller, anyone may have a contact
- the bot speaks Czech, but the doctors are Romanian, French and so on - it has to
  cope with foreign names as a Czech says them and as STT writes them down
- the only source of data is one endpoint, returns the whole list as JSON, answers
  in about 10 minutes
- there is no other route to current data. I asked about integrating the other way
  round (edit/create against our REST API whenever something changes) and the
  answer was that nothing further will be built on the hospital's side. This is
  everything we get.
- I also offered CRUD or a small UI where the hospital would maintain the doctors
  itself, possibly inside our own app, but they did not want to, so I dropped it
- the LLM only reads the data, no writes
- data freshness: assume once a day
- error rate: no specific number, "some standard one we agree on"
- I asked whether the line serves the whole hospital and whether there is an IVR in
  front of the bot - answer: assume not, the line is only for this
- the brief was about searching by surname. Speciality, city and language I added
  afterwards, because they struck me as the first thing a real patient says when
  they do not know the name.
- snapshot around 7000 records, about 3 MB

## identity: a problem I do not have

My first design worried about how to tell that a doctor changed between snapshots
(different surname, different phone) when the data carries no id. I went from
comparing name + email + phone all the way to a vector database, which I then
rejected myself as expensive to run.

I simply do not have that problem. Nothing is attached to a doctor - no bookings,
no history - so the snapshot is replaced wholesale and identity never comes up.
One question decides it: *does any state of ours hang off a doctor?* While the
answer is no, a stable id is wasted work. If "and book me in" ever arrives it
changes the whole design: state appears that is tied to a specific doctor, and
identity suddenly matters.

A finding in the data points the same way: 616 groups where the same name plus
clinic carries a different speciality and a different phone. Either that is one
person in several places or two people. I do not know, and that is exactly why
identity is not modelled (details in DECISIONS.md).

One thing for next time: ask about data freshness and error tolerance up front,
rather than when the design walks into them.

## assumptions I would verify

- a daily cron is enough -> check how often the list really changes; if it moves
  weekly, a weekly batch will do
- error tolerance -> I need to know which is worse: failing to find a doctor who
  exists, or handing out the wrong phone number. That sets the threshold at which
  the bot asks about the name.
- call volume -> how many calls a day and what the peaks look like; it decides
  whether SQLite and a single process are enough
- where to hand the call off when the bot finds nothing or is unsure - reception?
  nowhere?
- acute symptoms -> the bot says "Volejte okamžitě 155." and nothing else. It was
  not in the brief, I added it out of common sense. Today it is not just a prompt
  instruction but a deterministic rule in code (`src/emergency.ts`); the hospital
  may well have its own procedure, a transfer to urgent care say, and that should
  win.

## open questions before a pilot

- where should the bot transfer a call it cannot answer? is there a reception desk?
- what should happen after "Volejte okamžitě 155." - hang up? transfer?
- do you have call recordings? Real manglings of names are worth more for evals
  than invented ones; so far I have used 43 of my own dictated transcripts
  (`evals/stt-transcripts.txt`)
- how many calls a day are "I am looking for a doctor", and how long does that take
  reception today
- how do you measure today that the patient got what they wanted
- are there doctors in the list who should not be offered (away long term, by
  referral only)?
- languages - is a "speaks French" filter enough, or should the bot switch language?

## what success is and how I measure it

- success = the patient gets the right doctor or the right contact without being
  handed to a human, and the bot says nothing that is not in the data
- when there are several candidates (fifty Nováks), the bot must not ask about what
  they all share but about what rules out the most: city, speciality, name. I said
  this on the call already; in the code it is best_question
- the goal is 95 % of calls going straight through. The rest (renamings, pairs with
  the same name, strange transcripts) gets tuned from a pilot and shadow mode, not
  up front
- containment - the share of calls handled without a transfer; my estimate at the
  start is 50-60 %, the goal is that 95 %, it is a narrow use case
- correctness - the share of handled calls where the doctor really was the right
  one. More important to me than containment: a wrong phone number is worse than a
  transfer. Measured by sampling calls into a review queue every week.
- how many calls needed "did I hear that right?" or "which one do you mean?" - when
  that climbs, STT or the transliteration is limping
- not found - every such call is a candidate for a new eval
- latency per turn - the goal is under 1.5 s from the end of the sentence to the
  start of the answer. So far I only measure API + DB, without STT and TTS, and it
  is not there: the last run gives 6.7 s per turn and 2.1 s to the first token.
  Note that the runner originally printed the time for a whole call, which made it
  look like 8.9 s; a turn and a call are not the same unit (evals/RUNS.md).
- without production, evals are only a proxy. Every case has a defined behaviour
  (found / asked / confirmed / not found / refused / 155 / contact), and the runner
  prints the score, the latency and the distribution of outcomes.
- I would want the same table out of production for every call: outcome, number of
  turns, latency, and whether the patient called again within 24 h (a stand-in for
  FCR until I have something better)

## next step, if this were real

- shadow mode alongside reception on real calls
- evals built from those, on real manglings
- a pilot on one line with a review queue, then rollout
