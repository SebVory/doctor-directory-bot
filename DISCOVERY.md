# discovery - poznamky

raw poznamky z cviceni s Matejem (pa 11.9.) + co jsem si domyslel az potom. nic z toho neni overene s nemocnici, je to jak jsem to pochopil ja. kde jsem si neco domyslel, je to napsane jako predpoklad.

## co jsem zjistil v hovoru

- nemocnicni sit, hlasovy bot, pacient vola a hleda doktora
- je to v podstate verejny adresar, "zlate stranky" - takze zadny trust issue, doktori nemaji problem data dat ven, kdokoli si to muze najit
- proto neresim overeni volajiciho, kontakt muze dostat kazdy
- bot mluvi cesky, ale doktori jsou Rumuni, Francouzi atd. - bot si musi poradit s cizimi jmeny, jak je cech vyslovi a jak to STT prepise
- jediny zdroj dat = jeden endpoint, vrati cely seznam v jsonu, odpovida cca 10 minut
- ptal jsem se jestli neni jina cesta jak mit data aktualni - integrace do jejich systemu, at kdyz zmeni doktora tak nam posle edit/create na nas REST api - ne, nemocnice nebude delat nic dalsiho. tohle je vsechno co dostaneme
- predpokladal jsem ze nas LLM muze do dat jen cist, zadne zapisy
- cerstvost dat: ptal jsem se (ne hned na zacatku, ale dosel jsem k tomu) - predpokladame jednou denne
- chybovost: taky jsem se ptal - "nejaka standardni na ktere se domluvime", zadne cislo
- ptal jsem se jestli linka slouzi cele nemocnici a jestli je pred botem nejaky IVR automat - predpokladame ze neni, linka je jen na tohle
- resili jsme jen case kdy pacient hleda podle prijmeni. obor + mesto + jazyk jsem pridal az potom, prislo mi to jako to prvni co realny pacient rekne kdyz jmeno nezna
- snapshot ~7000 zaznamu, ~3MB

## kde jsem se zasekl a proc zbytecne

- resil jsem jak poznat ze se doktor mezi snapshoty zmenil (prejmenoval, novy telefon) kdyz nemam zadne id
- navrhl jsem porovnavat podle kombinace jmeno + email + telefon, pak vektorovou db, tu jsem sam zavrhl ze je draha na provoz
- az po cviceni mi doslo ze ten problem vubec nemam. na doktory si nic nevazu (zadne rezervace, zadna historie), takze snapshot proste cely prepisu a identitu neresim
- kdybych se hned na zacatku zeptal "vazeme si na doktora nejaky vlastni stav?" tak jsem si usetril 10 minut. tohle je pro me hlavni lekce z toho cviceni
- druha vec: na cerstvost a chybovost jsem se mel zeptat driv, ne az kdyz jsem k tomu dosel v navrhu

## co jsem si domyslel a co bych normalne overil

- denni cron staci -> overit jak casto se seznam realne meni. pokud jednou tydne, muzu jet tydne a je klid
- chybovost -> potrebuju vedet co je horsi: nenajit existujiciho doktora, nebo dat spatny telefon. podle toho nastavim prah kdy se bot doptava na jmeno
- pacient se neobjednava, jen hleda -> kdyby prislo "a objednejte me", meni to vsechno, najednou mam stav navazany na doktora a identita je dulezita
- objem hovoru neznam -> kolik hovoru denne, spicky. rozhoduje jestli staci sqlite a jeden proces
- kam predat hovor kdyz bot nenajde nebo si neni jisty? recepce? nikam? nevim
- akutni priznaky -> bot rekne "volejte 155" a nic vic. v zadani nebylo, dal jsem to tam ze zdraveho rozumu, ale nemocnice muze mit vlastni postup (prepojit na urgent)
- v datech je 616 skupin kde stejne jmeno + klinika ma jiny obor a jiny telefon. bud je to stejny clovek na vic mistech, nebo dva lidi. nevim, a je to presne duvod proc identitu neresit

## na co bych se ptal na "poradnem" discovery

- kam ma bot predat hovor kdyz nenajde? existuje recepce?
- co se ma stat po "volejte 155" - zavesit? prepojit?
- mate nahravky hovoru? z nich bych vytahl realna zkomoleni jmen pro evals
  (14. 9. 2026: vymyslene uz nejsou — evals bezi na 43 realnych prepisech z diktovani, viz evals/stt-transcripts.txt)
- kolik hovoru denne je "hledam doktora" a jak dlouho to dnes trva recepci
- jak dnes merite ze pacient dostal co chtel
- jsou v seznamu doktori ktere se nemaji nabizet (dlouhodobe pryc, jen na doporuceni)?
- jazyky - staci filtr "mluvi francouzsky", nebo ma bot umet prepnout jazyk?

## co je uspech a jak to merim

- uspech = pacient dostane spravneho doktora nebo spravny kontakt bez predani cloveku, a bot pritom nerekne nic co v datech neni
- containment - podil hovoru vyrizenych bez predani. odhad na start tak 50-60%, je to uzky use case
- spravnost - podil vyrizenych hovoru kde byl doktor opravdu ten spravny. pro me dulezitejsi nez containment, spatny telefon je horsi nez prepojeni. merit vzorkem hovoru do review queue kazdy tyden
- kolik hovoru potrebovalo "slysel jsem spravne?" nebo "ktereho myslite?" - kdyz to roste, kulha STT nebo transliterace
- not found - kazdy takovy hovor je kandidat na novy eval
- latence na tah - cil pod 1.5s od konce vety do zacatku odpovedi. ted merim jen api + db, bez STT a TTS
- ted bez produkce jsou evals jen proxy. kazdy pripad ma definovane chovani (nasel / doptal se / potvrdil / nenasel / odmitl / 155 / kontakt), runner vypise skore, latenci a rozdeleni vysledku
- stejnou tabulku bych chtel z produkce za kazdy hovor: vysledek, pocet tahu, latence, a jestli pacient volal znovu do 24h (nahrada za FCR dokud nemam nic lepsiho)

## dalsi krok kdyby to bylo real

- shadow mode vedle recepce na realnych hovorech
- z nich evals z realnych zkomolenin misto vymyslenych
- pilot na jedne lince s review queue, pak rollout
