// functions/api/tunnel-history.js

const MANUAL_TUNNEL_HISTORY_SEED = {
  byfjord: "2026-02-25T19:27:00+01:00",
  mastrafjord: "2026-02-16T08:30:00+01:00",
  eiganes: "2026-01-23T16:05:00+01:00",
  ryfast: "2026-02-20T19:20:00+01:00",
};

function normalizeHistorySeed(seed) {
  const out = {};
  for (const [key, value] of Object.entries(seed || {})) {
    if (!value) continue;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) continue;
    out[key] = d.toISOString();
  }
  return out;
}

export async function onRequest() {
  const cache = caches.default;
  const historyCacheKey = new Request("https://trafikkmeldinger.internal/tunnel-history.json", {
    method: "GET",
  });

  const cached = await cache.match(historyCacheKey);
  const history = cached ? await cached.json().catch(() => ({})) : {};
  const normalizedSeed = normalizeHistorySeed(MANUAL_TUNNEL_HISTORY_SEED);

  return new Response(JSON.stringify({
    updated: new Date().toISOString(),
    tunnelHistory: {
      ...normalizedSeed,
      ...(history && typeof history === "object" ? history : {}),
    },
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=120",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
