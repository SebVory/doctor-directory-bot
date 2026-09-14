/**
 * Stand-in for the hospital's single endpoint: returns the whole doctor list and
 * takes minutes to do it. SLOW_MS defaults to 3s here; the real one is ~600000.
 *
 * The full snapshot from the exercise is not committed, so a fresh clone falls
 * back to the 500-row sample and still runs end to end.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4010);
const SLOW_MS = Number(process.env.SLOW_MS ?? 3000);

const FULL_SNAPSHOT = "./data/full-snapshot/data-snapshot.json";
const SAMPLE = "./data/data-sample.json";

function resolveDataFile(): string {
  const explicit = process.env.SNAPSHOT_FILE;
  if (explicit !== undefined) {
    if (existsSync(explicit)) return explicit;
    console.error(`[mock-hospital] SNAPSHOT_FILE points at ${explicit}, which does not exist`);
    process.exit(1);
  }
  if (existsSync(FULL_SNAPSHOT)) return FULL_SNAPSHOT;
  if (existsSync(SAMPLE)) {
    console.log(`[mock-hospital] no full snapshot at ${FULL_SNAPSHOT} — serving the 500-row sample`);
    return SAMPLE;
  }
  console.error(`[mock-hospital] no data to serve. Expected ${FULL_SNAPSHOT} or ${SAMPLE} (run: npm run sample)`);
  process.exit(1);
}

const DATA_FILE = resolveDataFile();

const server = createServer((req, res) => {
  if (req.method !== "GET" || req.url?.startsWith("/doctors") !== true) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "only GET /doctors" }));
    return;
  }

  console.log(`[mock-hospital] GET ${req.url} — holding ${SLOW_MS} ms`);
  const timer = setTimeout(() => {
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": statSync(DATA_FILE).size,
    });
    createReadStream(DATA_FILE).pipe(res);
  }, SLOW_MS);

  res.on("close", () => clearTimeout(timer));
});

server.listen(PORT, () => {
  console.log(`[mock-hospital] http://localhost:${PORT}/doctors · ${DATA_FILE} · delay ${SLOW_MS} ms`);
});
