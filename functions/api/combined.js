// functions/api/combined.js

const MANUAL_TUNNEL_HISTORY_SEED = {
  // Midlertidig manuell seed, brukes kun hvis vi mangler sentral historikk.
  // Oppdater disse datoene ved behov.
  byfjord: "2026-02-25T19:27:00+01:00",
  mastrafjord: "2026-02-16T08:30:00+01:00",
  eiganes: "2026-01-23T16:05:00+01:00",
  hundvag: "",
  ryfast: "2026-02-20T19:20:00+01:00",
  sotra: "",
  solbakk: "",
  storhaug: "",
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

export async function onRequest(context) {
  const env = context.env || {};
  const user = env.DATEX_USER;
  const pass = env.DATEX_PASS;

  const upstream =
    "https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi/GetSituation/pullsnapshotdata";
  const timeoutMs = 10000;

  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).toString(), {
    method: "GET",
  });
  const historyCacheKey = new Request("https://trafikkmeldinger.internal/tunnel-history.json", {
    method: "GET",
  });

  const headers = {
    "User-Agent": "Byfjordtunnelen/1.0 (Cloudflare Pages)",
  };

  if (user && pass) {
    headers.Authorization = "Basic " + btoa(`${user}:${pass}`);
  }

  const buildPayload = (messagesClean, previousHistory = {}, seedHistory = {}) => {
    // Strengt kommune filter: krev lokal stedsreferanse, ikke vegnummer.
    // Ikke ha E39 her, den ødelegger alt.
    const stavangerMustHave = [
      "stavanger",
      "byfjord",
      "byfjordtunnelen",
      "hundvåg",
      "tasta",
      "madla",
      "kvernevik",
      "sunde",
      "våland",
      "eiganes",
      "storhaug",
      "hillevåg",
      "hinna",
      "gausel",
      "jåttå",
      "mariero",
      "forus",

      // Stavanger kommune inkluderer øyene
      "rennesøy",
      "finnøy",
      "mosterøy",
      "åmøy",
      "vassøy",
    ];

    // Ekskluder nabokommuner som ofte dukker opp i tekst
    const stavangerExclude = [
      "sandnes",
      "sola",
      "tananger",
      "randaberg",
      "klepp",
      "time",
      "bryne",
      "hå",
      "skien",
      "molde",
      "kristiansand",
      "trondheim",
      "skuan",
      "skaun",
    ];

    const monitoredTunnelKeywords = [
      "byfjord",
      "byfjordtunnelen",
      "mastrafjord",
      "mastrafjordtunnelen",
      "mastra",
      "eiganes",
      "eiganestunnelen",
      "hundvåg",
      "hundvaag",
      "hundvågtunnelen",
      "ryfylke",
      "ryfast",
      "ryfylketunnelen",
      "solbakk",
      "solbakktunnelen",
      "storhaug",
      "storhaugtunnelen",
      "sotra",
      "sotrasambandet",
    ];

    function isStavanger(m) {
      const t = `${m.title || ""} ${m.text || ""} ${m.where || ""}`.toLowerCase();

      // Behold alltid meldinger for tunneler vi overvåker,
      // selv om teksten også nevner nabokommuner (f.eks. Randaberg).
      const isMonitoredTunnel = monitoredTunnelKeywords.some((w) => t.includes(w));
      if (isMonitoredTunnel) return true;

      const hasLocal = stavangerMustHave.some((w) => t.includes(w));
      if (!hasLocal) return false;

      const hasBad = stavangerExclude.some((w) => t.includes(w));
      if (hasBad) return false;

      return true;
    }


    function isClosureMessage(m) {
      const txt = `${m.title || ""} ${m.text || ""}`.toLowerCase();
      return /stengt|steng[te]|closed?|closure|sperr[et]|blocked?|impassable|ikke farbar/.test(txt);
    }

    const tunnelKeywords = {
      byfjord: ["byfjord", "byfjordtunnelen"],
      mastrafjord: ["mastrafjord", "mastrafjordtunnelen", "mastra"],
      eiganes: ["eiganes", "eiganestunnelen"],
      hundvag: ["hundvåg", "hundvaag", "hundvågtunnelen"],
      ryfast: ["ryfast", "ryfylke", "ryfylketunnelen"],
      sotra: ["sotra", "sotrasambandet"],
      solbakk: ["solbakk", "solbakktunnelen"],
      storhaug: ["storhaug", "storhaugtunnelen"],
    };

    const stavangerOnly = messagesClean.filter(isStavanger);

    // Fallback hvis tomt, ellers begrens til 25
    const localOnly = stavangerOnly.length ? stavangerOnly.slice(0, 25) : messagesClean.slice(0, 25);

    const nowIso = new Date().toISOString();

    const tunnelHistory = { ...seedHistory, ...previousHistory };
    for (const [tunnelKey, keywords] of Object.entries(tunnelKeywords)) {
      const latestClosure = localOnly
        .filter((m) => {
          const txt = `${m.title || ""} ${m.text || ""} ${m.where || ""}`.toLowerCase();
          return keywords.some((keyword) => txt.includes(keyword)) && isClosureMessage(m);
        })
        .map((m) => m.time || nowIso)
        .filter(Boolean)
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

      if (latestClosure) {
        tunnelHistory[tunnelKey] = latestClosure;
      }
    }

    // Byfjord status heuristikk
    const byfjordMsg = localOnly.find((m) => `${m.title} ${m.text} ${m.where}`.toLowerCase().includes("byfjord"));
    const byTxt = byfjordMsg ? `${byfjordMsg.title} ${byfjordMsg.text} ${byfjordMsg.where}`.toLowerCase() : "";

    let byStatus = "ÅPEN";
    if (byfjordMsg && /stengt|tunnel stengt|closed|closure/.test(byTxt)) byStatus = "STENGT";
    else if (byfjordMsg && /kolonne|stans|omkjøring|lysregulering|dirigering|redusert/.test(byTxt)) byStatus = "AVVIK";

    return {
      updated: nowIso,
      stavanger: { messages: localOnly },
      byfjord: {
        status: byStatus,
        reason: byfjordMsg ? (byfjordMsg.text || byfjordMsg.title) : "",
        updated: nowIso,
        cameras: {
          retningByfjordtunnelen: { image: "", updated: nowIso },
          retningStavanger: { image: "", updated: nowIso },
        },
      },
      tunnelHistory,
    };
  };

  const cached = await cache.match(cacheKey);
  const historyCached = await cache.match(historyCacheKey);
  const previousHistory = historyCached ? await historyCached.clone().json().catch(() => ({})) : {};
  const seedHistory = normalizeHistorySeed(MANUAL_TUNNEL_HISTORY_SEED);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(upstream, {
      method: "GET",
      headers,
      signal: controller.signal,
      cf: {
        cacheTtl: 30,
        cacheEverything: true,
      },
    });

    clearTimeout(timeoutId);
    const xml = await res.text();

    if (!res.ok) {
      if (cached) {
        const payload = await cached.json();
        return json(
          { ...payload, tunnelHistory: payload.tunnelHistory || previousHistory || seedHistory || {}, source: "stale-cache", stale: true, staleReason: `Upstream ${res.status}` },
          200,
          "public, max-age=10, s-maxage=20, stale-while-revalidate=120"
        );
      }

      return json(
        {
          updated: new Date().toISOString(),
          error: `Upstream ${res.status}`,
          raw: xml.slice(0, 2000),
        },
        502
      );
    }

    const rawMessages = extractMessagesFromDatex(xml);

    // Dedup på tekst og lokasjon
    const seen = new Set();
    const messagesClean = [];
    for (const m of rawMessages) {
      const key = `${(m.text || m.title || "").trim().toLowerCase()}|${(m.where || "").trim().toLowerCase()}`;
      if (!key.trim()) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      messagesClean.push(m);
    }

    const payload = { ...buildPayload(messagesClean, previousHistory || {}, seedHistory), source: "live", stale: false };
    const response = json(payload, 200, "public, max-age=15, s-maxage=30, stale-while-revalidate=120");

    const historyResponse = new Response(JSON.stringify(payload.tunnelHistory || {}), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=300",
      },
    });

    if (context.waitUntil) {
      context.waitUntil(Promise.all([
        cache.put(cacheKey, response.clone()),
        cache.put(historyCacheKey, historyResponse),
      ]));
    } else {
      await cache.put(cacheKey, response.clone());
      await cache.put(historyCacheKey, historyResponse);
    }

    return response;
  } catch (e) {
    if (cached) {
      const payload = await cached.json();
      return json(
        {
          ...payload,
          tunnelHistory: payload.tunnelHistory || previousHistory || seedHistory || {},
          source: "stale-cache",
          stale: true,
          staleReason: String(e && e.name ? e.name : "upstream-error"),
        },
        200,
        "public, max-age=10, s-maxage=20, stale-while-revalidate=120"
      );
    }

    if (String(e && e.name) === "AbortError") {
      return json(
        {
          updated: new Date().toISOString(),
          error: "Upstream timeout",
        },
        504
      );
    }

    return json(
      {
        updated: new Date().toISOString(),
        error: "Worker exception",
        message: String(e && e.message ? e.message : e),
      },
      500
    );
  }
}

function json(obj, status, cacheControl = "no-store") {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Robust DATEX extractor uten DOMParser
 * Henter comment og forsøker å trekke ut lokasjon, vegnummer, sted og retning
 */
function extractMessagesFromDatex(xml) {
  const records =
    xml.match(/<[^:>]*:?situationRecord\b[\s\S]*?<\/[^:>]*:?situationRecord>/g) || [];

  const decodeXml = (s) =>
    (s || "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

  const stripTags = (s) => (s || "").replace(/<[^>]+>/g, " ");

  const normalize = (s) =>
    decodeXml(stripTags(s))
      .replace(/\s+/g, " ")
      .replace(/\|/g, "\n")
      .trim();

  const pick = (block, tag) => {
    const re = new RegExp(`<[^:>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tag}>`, "i");
    const m = block.match(re);
    return m ? normalize(m[1]) : "";
  };

  const pickAll = (block, tag) => {
    const re = new RegExp(`<[^:>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tag}>`, "gi");
    const out = [];
    let m;
    while ((m = re.exec(block)) !== null) {
      const v = normalize(m[1]);
      if (v) out.push(v);
      if (out.length >= 6) break;
    }
    return out;
  };

  const uniqJoin = (parts) => {
    const seen = new Set();
    const out = [];
    for (const p of parts) {
      const v = (p || "").trim();
      if (!v) continue;
      const k = v.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
    return out.join(" • ");
  };

  const buildWhere = (r) => {
    // Disse taggene varierer mellom records, vi prøver flere
    const roadNumber = pick(r, "roadNumber") || pick(r, "road") || "";
    const roadName = pick(r, "roadName") || pick(r, "roadNameText") || "";
    const locationDesc =
      pick(r, "locationDescription") ||
      pick(r, "locationDescriptionText") ||
      pick(r, "descriptor") ||
      "";
    const direction = pick(r, "direction") || pick(r, "directionOfTravel") || "";

    // Noen feeds har referanser med tekst i flere felt
    const placeBits = [
      ...pickAll(r, "name"),
      ...pickAll(r, "tpegDescriptor"),
      ...pickAll(r, "pointDescriptor"),
    ].slice(0, 4);

    const parts = [
      roadNumber,
      roadName,
      direction,
      locationDesc,
      placeBits.join(" "),
    ];

    // Rydd bort alt som bare er ord som ikke hjelper
    const where = uniqJoin(parts).trim();
    return where;
  };

  const messages = [];

  for (const r of records) {
    const commentRaw = pick(r, "comment");
    const text = (commentRaw || "").trim();

    const severity = pick(r, "severity") || pick(r, "impactOnTraffic") || "INFO";
    const created = pick(r, "situationRecordCreationTime") || pick(r, "versionTime") || "";

    const where = buildWhere(r);

    const title = text ? text.split(".")[0].slice(0, 90) : "Trafikkmelding";

    if (!title && !text) continue;

    messages.push({
      title,
      text,
      where,
      severity: severity || "INFO",
      time: created,
    });

    if (messages.length >= 80) break;
  }

  return messages;
}
