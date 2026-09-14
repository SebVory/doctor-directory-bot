/**
 * Builds data/data-sample.json: a ~500-row stratified slice of the full snapshot.
 *
 * Stratified, not random: a naive head/middle/end slice can miss whole
 * specialities or towns, and then the matcher tests silently stop covering them.
 * Order of business — cover every categorical value, pin the rows that make the
 * known-hard cases reproducible, then stride-fill to keep the distribution.
 *
 * Deterministic: same input, same output, no seed to remember.
 */
import { readFileSync, writeFileSync } from "node:fs";

const TARGET = Number(process.env.SAMPLE_SIZE ?? 500);
const SOURCE = process.env.SNAPSHOT_FILE ?? "./data/full-snapshot/data-snapshot.json";
const OUT = "./data/data-sample.json";

type Row = Record<string, unknown> & {
  last_name: string;
  first_name: string;
  clinic_name: string;
  speciality: string;
  location: string;
  languages: string[];
  phone: string;
};

const rows = JSON.parse(readFileSync(SOURCE, "utf8")) as Row[];
const picked = new Set<number>();

/** Pick one not-yet-taken row for each value, so every value appears at least once. */
function coverBy(values: Set<string>, valueOf: (row: Row) => string[]): void {
  for (const value of values) {
    const index = rows.findIndex((row, i) => !picked.has(i) && valueOf(row).includes(value));
    if (index >= 0) picked.add(index);
  }
}

const specialities = new Set(rows.map((r) => r.speciality));
const locations = new Set(rows.map((r) => r.location));
const languages = new Set(rows.flatMap((r) => r.languages));
const surnames = new Set(rows.map((r) => r.last_name));

coverBy(specialities, (r) => [r.speciality]);
coverBy(locations, (r) => [r.location]);
coverBy(languages, (r) => r.languages);
coverBy(surnames, (r) => [r.last_name]);

// Pin the ambiguity the bot is supposed to handle: same surname + speciality +
// city, so "hledám doktora Dumitresku, psychiatra v Kluži" still has two answers.
const ambiguityKey = (r: Row): string => `${r.last_name}|${r.speciality}|${r.location}`;
const byAmbiguity = new Map<string, number[]>();
rows.forEach((row, i) => {
  const key = ambiguityKey(row);
  byAmbiguity.set(key, [...(byAmbiguity.get(key) ?? []), i]);
});
for (const indices of [...byAmbiguity.values()].filter((g) => g.length > 1).slice(0, 15)) {
  for (const i of indices) picked.add(i);
}

// Pin the irreducible pairs: same given name, surname, city and speciality,
// differing only in phone, address and languages. Nothing a caller knows can
// separate these, so they are what the languages fallback exists for — and
// without one pinned, the test covering it silently passes on an empty set.
const irreducibleKey = (r: Row): string =>
  `${r.first_name}|${r.last_name}|${r.location}|${r.speciality}`;
const byIrreducible = new Map<string, number[]>();
rows.forEach((row, i) => {
  const key = irreducibleKey(row);
  byIrreducible.set(key, [...(byIrreducible.get(key) ?? []), i]);
});
for (const indices of [...byIrreducible.values()].filter((g) => g.length > 1).slice(0, 3)) {
  for (const i of indices) picked.add(i);
}

// Pin a few id-collision groups: same name + clinic, different speciality and
// phone. These are why the id is not just the three specified fields.
const collisionKey = (r: Row): string => `${r.last_name}|${r.first_name}|${r.clinic_name}`;
const byCollision = new Map<string, number[]>();
rows.forEach((row, i) => {
  const key = collisionKey(row);
  byCollision.set(key, [...(byCollision.get(key) ?? []), i]);
});
for (const indices of [...byCollision.values()].filter((g) => g.length > 1).slice(0, 10)) {
  for (const i of indices) picked.add(i);
}

// Fill the rest with an even stride across the whole file, so the sample keeps
// the shape of the data rather than the shape of its first N rows.
const stride = Math.max(1, Math.floor(rows.length / Math.max(1, TARGET - picked.size)));
for (let i = 0; i < rows.length && picked.size < TARGET; i += stride) picked.add(i);

const sample = [...picked]
  .sort((a, b) => a - b)
  .flatMap((i) => {
    const row = rows[i];
    return row === undefined ? [] : [row];
  });
writeFileSync(OUT, `${JSON.stringify(sample, null, 1)}\n`);

const has = <T,>(all: Set<T>, got: Set<T>): string => `${got.size}/${all.size}`;
console.log(`${OUT}: ${sample.length} rows from ${rows.length}`);
console.log(`  specialities ${has(specialities, new Set(sample.map((r) => r.speciality)))}`);
console.log(`  locations    ${has(locations, new Set(sample.map((r) => r.location)))}`);
console.log(`  languages    ${has(languages, new Set(sample.flatMap((r) => r.languages)))}`);
console.log(`  surnames     ${has(surnames, new Set(sample.map((r) => r.last_name)))}`);
