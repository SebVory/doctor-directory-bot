# discovery - poznamky

Inzenyrsky discovery log k tomuhle cviceni: co jsem o zadani zjistil, co jsem si
domyslel a co zustalo otevrene. Zmerena rozhodnuti a historie bezu jsou jinde,
v [DECISIONS.md](DECISIONS.md) a [evals/RUNS.md](evals/RUNS.md).

Nic z toho neni overene s nemocnici, je to jak jsem zadani pochopil ja. Kde jsem
si neco domyslel, je to napsane jako predpoklad.

## zadani, jak jsem mu porozumel

- nemocnicni sit, hlasovy bot, pacient vola a hleda doktora
- je to v podstate verejny adresar, "zlate stranky" - doktori maji kontakt verejne,
  takze neresim overeni volajiciho, kontakt muze dostat kdokoli
- bot mluvi cesky, ale doktori jsou Rumuni, Francouzi atd. - musi si poradit s
  cizimi jmeny tak, jak je cech vyslovi a jak je STT prepise
- jediny zdroj dat = jeden endpoint, vrati cely seznam v jsonu, odpovida cca 10 minut
- jina cesta k aktualnim datum neni. Ptal jsem se na integraci opacnym smerem
  (edit/create na nase REST API pri zmene), odpoved byla, ze nic dalsiho na strane
  nemocnice nevznikne. Tohle je vsechno, co dostaneme.
- nabidl jsem i CRUD nebo male UI, kde by si nemocnice doktory editovala sama,
  treba primo v nasi appce, ale delat by to nechteli, tak jsem to zkratoval
- LLM ma do dat jen cist, zadne zapisy
- cerstvost dat: predpokladame jednou denne
- chybovost: zadne konkretni cislo, "nejaka standardni, na ktere se domluvime"
- ptal jsem se, jestli linka slouzi cele nemocnici a jestli je pred botem IVR - odpoved:
  predpokladejme, ze neni, linka je jen na tohle
- zadani resilo hledani podle prijmeni. Obor + mesto + jazyk jsem pridal az potom,
  prislo mi to jako prvni vec, kterou realny pacient rekne, kdyz jmeno nezna.
- snapshot ~7000 zaznamu, ~3 MB

## identita: problem, ktery nemam

Prvni navrh resil, jak poznat, ze se doktor mezi snapshoty zmenil (jine prijmeni,
jiny telefon), kdyz data nemaji zadne id. Sel jsem pres porovnavani kombinace
jmeno + email + telefon az k vektorove databazi, kterou jsem sam zavrhl jako
drahou na provoz.

Ten problem ale vubec nemam. Na doktory se nic nevaze, zadne rezervace, zadna
historie, takze snapshot se cely prepise a identita se neresi. Otazka, ktera to
rozhodne, je jedina: *vaze se na doktora nejaky nas vlastni stav?* Dokud je
odpoved ne, je stabilni id zbytecna prace. Kdyby prislo "a objednejte me", meni to
cely navrh: vznika stav navazany na konkretniho doktora a identita je najednou
podstatna.

Stejnym smerem miri nalez v datech: 616 skupin, kde stejne jmeno + klinika ma jiny
obor a jiny telefon. Bud je to jeden clovek na vic mistech, nebo dva lide. Nevim,
a je to presne duvod, proc identitu nemodelovat (detail v DECISIONS.md).

Druha vec do priste: na cerstvost dat a chybovost se ptat hned, ne az kdyz na ne
narazim v navrhu.

## predpoklady, ktere bych overoval

- denni cron staci -> overit, jak casto se seznam realne meni; pri tydenni zmene
  staci tydenni davka
- chybovost -> potrebuju vedet, co je horsi: nenajit existujiciho doktora, nebo dat
  spatny telefon. Podle toho se nastavuje prah, kdy se bot doptava na jmeno.
- objem hovoru -> kolik hovoru denne a jake spicky; rozhoduje, jestli staci sqlite
  a jeden proces
- kam predat hovor, kdyz bot nenajde nebo si neni jisty - recepce? nikam?
- akutni priznaky -> bot rekne "Volejte okamzite 155" a nic dalsiho. V zadani to
  nebylo, dal jsem to tam ze zdraveho rozumu. Dnes to neni jen instrukce v promptu,
  ale deterministicke pravidlo v kodu (`src/emergency.ts`); nemocnice ale muze mit
  vlastni postup, treba prepojeni na urgent, a ten by mel vyhrat.

## otevrene otazky pred pilotem

- kam ma bot predat hovor, kdyz nenajde? existuje recepce?
- co se ma stat po "Volejte okamzite 155" - zavesit? prepojit?
- mate nahravky hovoru? Realne zkomoleniny jmen jsou pro evals cennejsi nez
  vymyslene; zatim jsem pouzil 43 vlastnich diktovanych prepisu (`evals/stt-transcripts.txt`)
- kolik hovoru denne je "hledam doktora" a jak dlouho to dnes trva recepci
- jak dnes merite, ze pacient dostal, co chtel
- jsou v seznamu doktori, kteri se nemaji nabizet (dlouhodobe pryc, jen na doporuceni)?
- jazyky - staci filtr "mluvi francouzsky", nebo ma bot umet prepnout jazyk?

## co je uspech a jak to merim

- uspech = pacient dostane spravneho doktora nebo spravny kontakt bez predani
  cloveku, a bot pritom nerekne nic, co v datech neni
- kdyz je kandidatu vic (padesat Novaku), bot se nema ptat na to, co maji vsichni
  stejne, ale na to, co jich vyradi nejvic: mesto, obor, jmeno. Tohle jsem rikal uz
  na callu, v kodu je to best_question
- cil je, aby 95 % hovoru proslo rovnou. Zbytek (prejmenovani, dvojice se stejnym
  jmenem, divne prepisy) se ladi az z pilotu a shadow modu, ne dopredu
- containment - podil hovoru vyrizenych bez predani; odhad na start 50-60 %, cil je
  tech 95 %, je to uzky use case
- spravnost - podil vyrizenych hovoru, kde byl doktor opravdu ten spravny. Pro me
  dulezitejsi nez containment: spatny telefon je horsi nez prepojeni. Merit vzorkem
  hovoru do review queue kazdy tyden.
- kolik hovoru potrebovalo "slysel jsem spravne?" nebo "ktereho myslite?" - kdyz to
  roste, kulha STT nebo transliterace
- not found - kazdy takovy hovor je kandidat na novy eval
- latence na tah - cil pod 1,5 s od konce vety do zacatku odpovedi. Merim zatim jen
  API + DB, bez STT a TTS, a k cili to zatim neni (posledni bezy v evals/RUNS.md).
- bez produkce jsou evals jen proxy. Kazdy pripad ma definovane chovani (nasel /
  doptal se / potvrdil / nenasel / odmitl / 155 / kontakt), runner vypise skore,
  latenci a rozdeleni vysledku.
- stejnou tabulku bych chtel z produkce za kazdy hovor: vysledek, pocet tahu,
  latence, a jestli pacient volal znovu do 24 h (nahrada za FCR, dokud nemam nic
  lepsiho)

## dalsi krok, kdyby to bylo real

- shadow mode vedle recepce na realnych hovorech
- z nich evals postavene na realnych zkomoleninach
- pilot na jedne lince s review queue, pak rollout
