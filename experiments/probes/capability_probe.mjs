/**
 * Capability probe for current Helius API key.
 *
 * Detects whether paid-only endpoints/features are available so scripts can
 * auto-select compatible engines and avoid wasted runs.
 */

function endpointForKey(apiKey) {
  return `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, text, json };
}

function messageOf(resp) {
  return resp?.json?.error?.message || resp?.text || "";
}

export async function probeCapabilities(apiKey) {
  const url = endpointForKey(apiKey);
  const testAddress = "54uJifihfpmTjCGperSxWaZmEHzGFpsaKKEiiGL1fmTs";

  const version = await postJson(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "getVersion",
    params: [],
  });

  const gta = await postJson(url, {
    jsonrpc: "2.0",
    id: 2,
    method: "getTransactionsForAddress",
    params: [testAddress, {
      transactionDetails: "signatures",
      sortOrder: "desc",
      limit: 5,
      filters: { status: "succeeded" },
    }],
  });

  const batch = await postJson(url, [
    { jsonrpc: "2.0", id: 10, method: "getVersion", params: [] },
    { jsonrpc: "2.0", id: 11, method: "getVersion", params: [] },
  ]);

  const paidCapable = gta.ok && !gta.json?.error;
  const batchAllowed = batch.ok && Array.isArray(batch.json);

  return {
    checkedAt: new Date().toISOString(),
    endpointReachable: version.ok,
    paidCapable,
    batchAllowed,
    mode: paidCapable ? "paid-capable" : "free-tier",
    details: {
      getVersion: { ok: version.ok, status: version.status, message: messageOf(version).slice(0, 140) },
      getTransactionsForAddress: { ok: gta.ok, status: gta.status, message: messageOf(gta).slice(0, 140) },
      batchRequests: { ok: batch.ok, status: batch.status, message: messageOf(batch).slice(0, 140) },
    },
  };
}

const _isCLI = process.argv[1] && new URL(import.meta.url).pathname === new URL(process.argv[1], "file://").pathname;
if (_isCLI) {
  const apiKey = process.argv[2] ?? process.env.HELIUS_API_KEY;
  if (!apiKey) {
    console.error("Usage: node capability_probe.mjs <api-key>");
    process.exit(1);
  }
  const cap = await probeCapabilities(apiKey);
  console.log(JSON.stringify(cap, null, 2));
}
