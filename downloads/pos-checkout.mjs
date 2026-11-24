// Run in the POS backend. Persist the intent UUID and checkout reference together before the first call.
// Re-running with these same arguments resumes the scan after a response or process is lost.
const [baseUrl, board, checkout, intentKey] = process.argv.slice(2);
const token = process.env.NDN_POS_TOKEN;
if (!baseUrl || !board || !checkout || !intentKey || !token || new URL(baseUrl).protocol !== "https:") {
  throw new Error("Set NDN_POS_TOKEN and pass HTTPS base URL, board ID, checkout reference and intent UUID.");
}
const base = baseUrl.replace(/\/$/, "");
async function call(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status} · ${body.code} · ${body.message}`);
  return body;
}
const accepted = await call(`/readers/${encodeURIComponent(board)}/scans`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Idempotency-Key": intentKey },
  body: JSON.stringify({ checkout_ref: checkout, antenna_sequence: [1, 3], max_duration_ms: 2000 }),
});
const path = `/scans/${accepted.scan_id}`;
let cursor, scan, reads = 0;
const epcs = new Set();
do {
  // Read status first. Once it is final, the following pages include the committed tail.
  scan = await call(path);
  let page;
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("after", cursor);
    page = await call(`${path}/observations?${query}`);
    for (const report of page.items) { epcs.add(report.epc_hex.toUpperCase()); reads++; }
    cursor = page.next_cursor;
  } while (page.has_more);
  if (scan.stream_quality === "pending") await new Promise(resolve => setTimeout(resolve, 200));
} while (scan.stream_quality === "pending");
console.log(JSON.stringify({ checkout, scan: scan.scan_id, state: scan.state, outcome: scan.outcome,
  quality: scan.stream_quality, unique_epcs: [...epcs], reads }, null, 2));
if (scan.outcome !== "success" || scan.stream_quality !== "complete" || scan.observations_persisted !== reads) {
  process.exitCode = 2; // Route this checkout to reconciliation before accepting its tag list.
}
