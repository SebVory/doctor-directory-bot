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

Ingest je naplánovaná úloha, dva tools Skill, prompt konfigurace agenta, evals
jejich evals. Preamble („Moment, podívám se") vracím zvlášť od odpovědi právě
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

Kontakt bot nenabídne sám, až když si o něj volající řekne.

## Co je v datech

7029 lékařů z 26 příjmení a 30 křestních jmen. **Žádné z 780 celých jmen
nepatří jen jednomu člověku**, nejčastější sdílí dvacet lidí — proto hledání
nikdy nekončí na jméně. Jméno, město a obor identifikují 99,1 %; zbylých 60
řádků je 30 dvojic lišících se jen telefonem, adresou a jazyky, a na ty se bot
ptá jazykem a řekne proč.

Tři pasti. Klinik je 42 a měst 42 a jsou to bijekce („Clinica {město} Care"),
takže otázka na kliniku je otázka na město jinými slovy — klinika je mimo sadu
otázek. E-mail se odvozuje ze jména a kliniky, takže 616 skupin lékařů (některé
po třech i čtyřech, dohromady 669 řádků nad rámec první v každé skupině) sdílí
schránku; kontakt nese `email_shared` a bot řekne, že přímý je telefon. PSČ je
náhodné (173 různých uvnitř Kluže), nepoužívá se.

<!-- SEBASTIAN: rewrite in your own words -->
## Rozhodnutí

**Nemocniční endpoint se nikdy nevolá během hovoru.** Odpovídá v řádu minut, takže
běží denně z cronu a hovor čte jen lokální SQLite snapshot.

**Snapshot se nahrazuje celý a atomicky, v jedné transakci.** `DROP`, `RENAME`,
indexy i `meta` jsou uvnitř jednoho `db.transaction(...)`. Když validace neprojde
nebo počet řádků spadne pod 70 % předchozího, swap se neprovede, zůstává stará
tabulka a bot umí říct, z kdy data jsou.

**Identita lékařů se nemodeluje.** 616 skupin sdílí jméno i kliniku, ale liší se
oborem, telefonem a adresou — proto je `id` jen per-snapshot hash, mění se s daty
a nic na něj není navázané.

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

<!-- /SEBASTIAN -->

## Co mě naučily reálné přepisy

Pustil jsem 43 skutečných přepisů z macOS diktování přes matcher offline a
pak přes agenta. Offline to vypadalo na 31 z 38 a chyby v městech; živě
spadlo 14 ze 43 a na úplně jiných věcech. Důvod je ten, že **model opraví
poškození z přepisu dřív, než ho tool uvidí**:

```
STT napsalo "Kůži"       → model poslal "Kluž"       → Cluj-Napoca
STT napsalo "ploj testi" → model poslal "Ploješť"    → Ploiesti
STT napsalo "Santumare"  → model poslal "Satu Mare"  → našel Andreje Rusu
```

Matcher jsem proto nechal být. Kdybych ho ladil podle offline tabulky,
přidal bych složitost pro problém, který v provozu nenastává — `y→i` fold
jsem změřil na 0,436 → 0,436, tedy nic. Výjimka je `Ilije` proti `Ilie`:
0,000 nebylo omezení trigramů, ale chybějící řádek v transliterační tabulce,
a po přidání `ije`/`ija` sedí na 1,000. Jedna výhrada: stojí to na tom, že
model zná rumunská města. U menšího modelu by to neplatilo a matcher by tu
práci musel odvést.

Čtyři věci, které živý běh vynutil. Bot potvrzoval jména, která vůbec nenašel
— pacientovi, který řekl Popescu, nabídl Dumitrescu na 0,31; pod 0,40 teď
žádný kandidát není. Pravidlo „nejmenuj jednoho z mnoha" bylo jen v promptu a
model ho porušil u 186 kandidátů, takže je teď `must_ask` v datech. Přepis
„restaurace" místo „doktorka" shodil hledání na odmítnutí. A práh pro potvrzení
závisí na množství nezávislé evidence: samotné příjmení 0,6, s oborem, městem,
jazykem nebo křestním jménem 0,45 — 0,50 uvnitř „pediatr v Brašově" je jiná
jistota než 0,50 nad 7029 řádky.

## Testy a evals

```
(sem přijde syrový výstup npm run typecheck && npm test)
```

```
(sem přijde syrový výstup npm run evals)
```

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
| `npm run evals` | Přehraje `evals/cases.json` přes agenta, kontroluje tool cally i odpověď, spadne pod 80 %. |
| `npm run typecheck` | `tsc --noEmit`. |


## Co vědomě chybí

Evals jsou z větší části jednotahové; dvoutahových a třítahových je šest a
pokrývají nejdůležitější tok, tedy doptání a kontakt až na vyžádání.

Latence je změřená bez STT a TTS. V discovery jsem si dal cíl pod 1,5 s od
konce věty do začátku odpovědi a **ten cíl zatím není splněný**: první token
mluvené odpovědi přijde kolem 1,6 s, celý tah trvá kolem 7 s. Čísla v evals
jsou za celý hovor, ne za tah — třítahový případ proto vychází přes 20 s.
Model, effort, velikost payloadu ani prompt cache s tím měřitelně nehnuly;
zbývá streaming do TTS a přemosťovací věta, kterou zatím žádný runtime
nepřehrává, protože runtime tu není.

Bez LangGraph; přerušení toku (potvrzení jména, povinné doptání) řeším flagy
v tool resultu. V grafu by to byl interrupt s checkpointem, první kandidát na
přepis.

Chybí shadow mode a monitoring. Obojí patří k pilotu, ne k zadání.
