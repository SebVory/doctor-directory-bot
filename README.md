# Doctor directory bot

Hlasový bot pro linku nemocniční sítě: pacient zavolá, řekne jméno lékaře nebo
obor a město, bot ho najde a přečte kontakt. Zadání z pohovoru ve Wonderful.
Od nemocnice dostaneme jediný endpoint, který vrátí celý seznam a odpovídá
zhruba deset minut — žádné webhooky, žádné inkrementální změny, nic jiného.

Co když se doktor přejmenuje? Nic, na doktory si nic nevážu a snapshot
přepisuju celý. A jménem by to stejně nešlo: ze 780 celých jmen nepatří žádné
jen jednomu člověku.

Předpoklady, otevřené otázky a definice úspěchu jsou v
[DISCOVERY.md](DISCOVERY.md), měření a rozhodnutí z nich v
[DECISIONS.md](DECISIONS.md).

## Kde končí moje část

```
  NEMOCNICE (black box)          MOJE ČÁST                    WONDERFUL
  ┌───────────────────┐   ┌──────────────────────────┐   ┌──────────────────┐
  │ GET /doctors      │   │ cron ingest (1× denně)   │   │ telefonie / SIP  │
  │ celý seznam       │──▶│   ↓ validace, guardy     │   │ STT  ──▶  ◀── TTS│
  │ ~10 min, 7029 řá. │   │ SQLite snapshot          │◀─▶│ orchestrátor     │
  │                   │   │   ↓                      │   │ agent runtime    │
  │ v repu: mock-api  │   │ 2 tools + prompt + evals │   │ v repu: CLI      │
  └───────────────────┘   └──────────────────────────┘   └──────────────────┘
```

Ingest je naplánovaná úloha, dva tools Skill, prompt konfigurace agenta a evals
jejich kontrola. Preamble („Moment, podívám se") vracím zvlášť od odpovědi právě
proto, aby ho runtime přehrál během tool callu — tam se vnímaná latence
schovává. Jak často stahovat je řádek v cronu a otázka na nemocnici, ne
konstanta v kódu.

## Jeden hovor

Skutečný průběh z eval běhu, 277 kandidátů na jednoho ve třech tazích:

```
👤 Hledám doktora Dumitresku                         277 kandidátů
🤖 Doktorů Dumitrescu mám víc. V jakém městě ordinuje — v Mediaši,
   v Brašově, v Kluži, nebo v Romanu?

👤 V Kluži                                            11 kandidátů
🤖 V Kluži jich mám jedenáct. Znáte křestní jméno — Alina, Andrei,
   Bogdan, nebo Cristina?

👤 Alinu                                               1 kandidát
🤖 Mám ji: doktorka Alina Dumitrescu, psychiatrie, Clinica Cluj-Napoca Care
```

Kontakt bot sám nenabízí; telefon nebo adresu načte až poté, co si o ně
volající výslovně řekne.

## Co je v datech

7029 lékařů z 26 příjmení a 30 křestních jmen. **Žádné z 780 celých jmen
nepatří jen jednomu člověku**, nejčastější sdílí dvacet lidí — proto hledání
nikdy nekončí na jméně. Jméno, město a obor identifikují 99,1 %; zbylých 60
řádků je 30 dvojic lišících se jen telefonem, adresou a jazyky, a na ty se bot
ptá jazykem a řekne proč.

Tři pasti. Klinik je 42 a měst 42 a v plném snapshotu tvoří bijekci: každé
město má jednu kliniku a každá klinika patří jednomu městu („Clinica {město}
Care“). Neznamená to jednu kliniku na jednoho lékaře, naopak mnoho lékařů sdílí
stejnou kliniku. Otázka na kliniku proto nepřinese nic navíc proti otázce na
město a v sadě disambiguačních otázek není. E-mail se odvozuje ze jména a
kliniky, takže 616 skupin lékařů (některé po třech i čtyřech, dohromady 669
řádků nad rámec první v každé skupině) sdílí schránku; kontakt nese
`email_shared` a bot řekne, že přímý je telefon. PSČ je náhodné (173 různých
uvnitř Kluže), nepoužívá se.

## Rozhodnutí

**Nemocniční endpoint se nikdy nevolá během hovoru.** Odpovídá v řádu minut, takže
běží denně z cronu a hovor čte jen lokální SQLite snapshot.

**Snapshot se nahrazuje celý a atomicky, v jedné transakci.** `DROP`, `RENAME`,
indexy i `meta` jsou uvnitř jednoho `db.transaction(...)`. Když validace neprojde
nebo počet řádků spadne pod 70 % předchozího, swap se neprovede, zůstává stará
tabulka a bot umí říct, z kdy data jsou.

**Identita lékařů se nemodeluje.** 616 skupin sdílí e-mail a některé kandidátní
skupiny sdílejí stejné jméno i kliniku, ale liší se oborem, telefonem nebo
adresou. Proto je `id` jen per-snapshot hash, mění se s daty a nic na něj není
navázané.

**Příjmení mají vlastní normalizaci.** České `-ová` nestálo správnost, ale
jistotu: „Rusuová" sedlo na „Rusu" jen na 0,721, tedy pod prahem, takže by se bot
ptal „slyšel jsem správně?" na jméno, které slyšel perfektně. Odstranění koncovky
zvedne 24 ze 78 skloňovaných tvarů z pod 0,8 na 1,000. Do obecného `normalize()`
to nesmí — město `Craiova` by se změnilo na `kraj`.

**Fuzzy hledání je stavěné proti českému STT**, ne proti překlepům: trigramový
Dice nad transliterační tabulkou, bonus za shodu prvních tří písmen, top 3
kandidáti. Nad víc kandidáty se bot doptá, pod skóre 0,6 si jméno ověří zpátky.

**Obory a města se zadávají česky** přes tabulku synonym a exonym (kardiolog →
Cardiology, Kluž → Cluj-Napoca). Bez příjmení se řadí podle hodnocení, ne podle
skóre jména.

**Akutní příznaky mají přednost před vším ostatním.** Bolest na hrudi, dušnost,
silné krvácení, bezvědomí nebo příznaky mrtvice končí jedinou větou „Volejte
okamžitě 155." Žádné volání nástroje, žádné hledání lékaře, nic dalšího — dokud
nevíme, že nejde o akutní stav, je hledání doktora ztráta času volajícího.
Neakutní potíže naopak vedou na nabídku oboru: „Bolest hlavy neumím posoudit ani
léčit. Můžu vám ale najít neurologa nebo praktického lékaře."

**Kontakt až na vyžádání.** Telefon a adresa nejdou do první odpovědi; jsou za
samostatným toolem, který se volá, teprve když si o ně volající řekne.

**Prázdná odpověď je chyba, ne edge case.** Strop smyčky, odmítnutí modelu i
prázdný text končí pevnou českou větou, která volajícímu řekne další krok. Evals
berou prázdnou odpověď vždy jako fail. Detekce jmen v out-of-scope případech jde
přes hranice slov, ne přes `includes` — jinak by se příjmení „Stan" našlo uvnitř
slova „stanovit" a případ by padal ze špatného důvodu.

**Evals mají vlastní pojistky, protože report se čte hůř než soubor.** Runner
odmítne start, dokud má některý případ prázdnou utterance, a validuje hodnoty
`behaviour` proti tabulce. Oboje vzniklo z reálné chyby při stavbě: dva případy,
o kterých jsem měl za to, že existují, ve skutečnosti chyběly, a jeden nesl
`behaviour: null`, což by běh shodilo. Nenašlo to čtení shrnutí, našla to
kontrola samotného souboru.

**Vzorek dat je stratifikovaný, ne náhodný.** Pokrytí se konstruuje: poziční
výřez ze středu souboru ztratil psychiatrii, a s ní hlavní dvojznačný případ.

**Známé omezení matcheru: krátká příjmení.** Čtyřpísmenná jména (Ilie, Popa,
Stan) mají příliš málo trigramů na to, aby přežila přeslech — „Ilije" sedne na
„Ilie" na 0,000, protože jedno změněné písmeno smaže celý překryv. Padá to
bezpečně do not_found, tedy na doptání, ne na špatného lékaře. Řešil by to
fonetický fallback (Daitch-Mokotoff nebo jednoduchý soundex) zapnutý jen pro
jména pod pět písmen. Vědomě neuděláno.

**Co vědomě chybí:** shadow mode, monitoring, reálné STT/TTS, rate limiting
a edge cases, které přinese až pilot.

## Co mě naučily reálné přepisy

Pustil jsem 43 skutečných přepisů z macOS diktování přes matcher offline a pak
přes agenta. Offline to vypadalo na 31 z 38, živě spadlo 14 ze 43 — a na úplně
jiných věcech. Důvod byl, že model opravoval poškození z přepisu dřív, než ho
tool uviděl: „Kůži" poslal jako „Kluž", „Santumare" jako „Satu Mare".

Chvíli jsem to považoval za dobrou zprávu a matcher nechal být. Byla to
unáhlená úvaha. Model ta jména neopravuje z dat — data nevidí — ale z toho, co
zná o rumunských jménech z tréninku. Je to hádání z priorů, ne vyhledávání, a
mělo dva důsledky. Když se trefil, dorazilo do storu čisté jméno se skóre 1,0 a
větev „slyšel jsem správně?" nevystřelila ani jednou (`confirm_name 0` ve všech
38 případech). Kdyby se netrefil a opravil na jiné existující rumunské příjmení,
store by to vzal jako jistotu a bot by bez ptaní pojmenoval špatného lékaře — a
v evals by to nebylo vidět, protože ve 38 případech se trefil pokaždé.

**Současný návrh je proto opačný: model předává příjmení, křestní jméno a město
doslova tak, jak zazněla, a hledání vlastní store**, který jediný vidí, jaká
jména v datech jsou. Tím se pojistka vrací. Opravu měst, kterou model do té doby
dělal zadarmo, musí od té chvíle umět matcher: města se porovnávají bez mezer, s
nižším prahem než obory, a synonyma jsou vytažená z reálných přepisů (`kuzi`,
`ploj testi`, `santumare`, `tam je svar`, `botan siker`), ne vymyšlená. Offline
na 43 přepisech to posunulo 31/7 na 35/3, bez jediného falešného nálezu mezi
devíti městy mimo síť a se všemi 42 městy, která pořád trefí sama sebe.

Se stejnou změnou padl i nižší práh pro potvrzení jména. Byl nastavený na 0,45,
když do storu chodila jména už opravená a skóre se pohybovala u jedničky. S
doslovným přepisem projde „stane zkus" na 0,579 a bez potvrzení by se přečetlo
jako fakt. Práh je teď jeden, 0,6, ať volající řekl cokoli dalšího.

**Poslední placený běh: 38/40 (95 %).** Ani jedna kontrola doslovného předání
argumentů do toolu neselhala.

**Důležitější signál než skóre:** `confirm_name` bylo 4 a „stane zkus“ skončilo
potvrzovací větví. Dva zbývající faily byly offline reprodukované jako artefakty
eval assertionů a opravené bez změny agenta nebo matcheru; po této opravě už
nový placený běh neproběhl.

Čtyři věci, které živý běh vynutil dřív. Bot potvrzoval jména, která vůbec
nenašel — pacientovi, který řekl Popescu, nabídl Dumitrescu na 0,31; pod 0,40
teď žádný kandidát není. Pravidlo „nejmenuj jednoho z mnoha" bylo jen v promptu
a model ho porušil u 186 kandidátů, takže je teď `must_ask` v datech. Přepis
„restaurace" místo „doktorka" shodil hledání na odmítnutí.

## Testy a evals

```
$ npm run typecheck && npm test
  Test Files  5 passed (5)
       Tests  184 passed (184)
   Duration  259ms
```

Historický běh před změnou na doslovné předávání do toolu:

```
$ npm run evals          # 38 případů, 14. 9. 2026
35/38 passed — 92% (threshold 80%) · conversation ms avg 8528, max 22330
                                    · TTFT avg 1733 ms, max 2608 ms (31 streamed)

outcome breakdown (what happened, not what was expected):
  emergency            3
  contact              6
  confirm_name         0
  ask_clarification   22
  not_found            4
  out_of_scope         3
  found                0
  other                0
```

Historický běh měl tři červené případy. Po změně promptu, prahu a checkeru ho
nepoužívám jako finální skóre současného návrhu; nový čistý běh bude zapsaný v
[evals/RUNS.md](evals/RUNS.md) včetně rozlišení chyby agenta, matcheru, case nebo
checkeru.

Offline měření pracovalo se 43 přepisy, starý agent eval měl 38 případů a
současný eval má 40 případů. Nejde o stejný denominator: 43 je sada surových
přepisů pro matcher, zatímco 38 a 40 jsou behaviorální scénáře pro agenta.

## Nastavení

Potřebuješ Node 20 nebo novější (vyvíjeno na 22) a klíč k Anthropic API.

```bash
npm install
cp .env.example .env      # a doplň ANTHROPIC_API_KEY
```

Plný snapshot ze zadání není v repu; committed je vzorek 500 řádků
(`data/data-sample.json`), na kterém běží všechno včetně testů. Pokud plný
snapshot v `data/full-snapshot/` chybí, `npm run mock-api` se na vzorek přepne
sám a napíše to.

Plný snapshot ze zadání zůstává lokální a je v `.gitignore`. V repu je jen
stratifikovaný 500řádkový vzorek, aby šel projekt naklonovat, spustit a otestovat
bez dalšího souboru. Čísla v `DECISIONS.md` označená jako měřená nad plným
snapshotem jsou výsledky nad interview fixture, ne nad commitnutým vzorkem.

Pořadí prvního spuštění — `ingest` potřebuje běžící `mock-api`, `doctor`
a `evals` potřebují naplněnou databázi:

```bash
npm run mock-api                          # 1. terminál, běží dál
npm run ingest                            # 2. terminál, jednou
npm run doctor -- "Hledám doktora Dumitresku"
```

`npm test` a `npm run typecheck` běží samostatně, databázi ani klíč nepotřebují.

## Příkazy

| Příkaz | Co dělá |
|---|---|
| `npm run mock-api` | Mock nemocničního endpointu na `:4010`, odpoví po `SLOW_MS` (default 3000, ostrý ~600000). |
| `npm run ingest` | Stáhne snapshot, zvaliduje Zodem, atomicky prohodí do `db/doctors.sqlite`; guardy na propad počtu řádků a na nevalidní řádky. |
| `npm run doctor -- "dotaz"` | Jeden dotaz přes agenta. Bez argumentu interaktivní režim. |
| `npm test` | Vitest: matcher (komolení z STT, synonyma, negativní případy) + guardy ingestu. |
| `npm run evals` | Přehraje `evals/cases.json` přes agenta, kontroluje tool cally i odpověď, spadne pod 80 %. Volá API, tedy stojí peníze. |
| `npm run evals -- --validate-only` | Jen zkontroluje `cases.json` — hodnoty `behaviour`, názvy nástrojů, délky `turn_behaviours` — a skončí. Žádné volání API. |
| `npm run typecheck` | `tsc --noEmit`. |

## Co vědomě chybí

Evals jsou z větší části jednotahové; dvoutahových a třítahových je šest a
pokrývají nejdůležitější tok, tedy doptání a kontakt až na vyžádání.

Latence je změřená bez STT a TTS. V discovery jsem si dal cíl pod 1,5 s od
konce věty do začátku odpovědi a **ten cíl zatím není splněný**: první token
mluvené odpovědi přijde v průměru za 1,7 s (max 2,6 s), celý tah trvá kolem 7 s.
Čísla v evals jsou za celý hovor, ne za tah — třítahový případ proto vychází přes
20 s. Model, effort, velikost payloadu ani prompt cache s tím měřitelně nehnuly;
zbývá streaming do TTS a přemosťovací věta, kterou zatím žádný runtime
nepřehrává, protože runtime tu není.

Bez LangGraph; přerušení toku (potvrzení jména, povinné doptání) řeším flagy
v tool resultu. V grafu by to byl interrupt s checkpointem, první kandidát na
přepis.

Chybí shadow mode a monitoring. Obojí patří k pilotu, ne k zadání.
