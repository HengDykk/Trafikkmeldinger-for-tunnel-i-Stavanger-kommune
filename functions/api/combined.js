// functions/api/combined.js

const MANUAL_TUNNEL_HISTORY_SEED = {
  // Midlertidig manuell seed, brukes kun hvis vi mangler sentral historikk.
  // Oppdater disse datoene ved behov.
  byfjord: "2026-02-25T14:45:00+01:00",
  mastrafjord: "",
  eiganes: "",
  hundvag: "",
  ryfast: "",
  finnoy: "",
  talgje: "",
  storhaug: "",
};

const TUNNEL_REGISTRY = {
  byfjord: { id: "10-8383248394a8c41b", name: "Byfjordtunnelen", matchTerms: ["byfjordtunnelen", "byfjord"] },
  mastrafjord: { id: "10-31b9ef1302194439", name: "Mastrafjordtunnelen", matchTerms: ["mastrafjordtunnelen", "mastrafjord"] },
  eiganes: { id: "10-3e9b280fc15f0540", name: "Eiganestunnelen", matchTerms: ["eiganestunnelen"] },
  hundvag: { id: "10-746700d70a0dd7cd", name: "Hundvågtunnelen", matchTerms: ["hundvågtunnelen", "hundvagtunnelen"] },
  ryfast: { id: "10-e0a2a18ca95b06c6", name: "Ryfylketunnelen", matchTerms: ["ryfylketunnelen", "ryfast"] },
  finnoy: { id: "10-92a98043d0a97d1e", name: "Finnøytunnelen", matchTerms: ["finnøytunnelen", "finnoytunnelen", "finnfast"] },
  talgje: { id: "10-cbdb03f70d66c4c3", name: "Talgjetunnelen", matchTerms: ["talgjetunnelen"] },
  storhaug: { id: "10-201a7ab572b246cd", name: "Storhaugtunnelen", matchTerms: ["storhaugtunnelen"] },
};

const TRAVEL_TIME_WFS_URL =
  "https://ogckart-sn1.atlas.vegvesen.no/datex_3_1/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=datex_3_1%3ATravelTimeSimple&outputFormat=application%2Fjson&bbox=5.2,58.85,6.3,59.25,EPSG:4326&maxFeatures=400";

const TRAVEL_TIME_ROUTE_MATCHERS = {
  byfjord: [
    "auglendshøyden - dusavik",
    "dusavik - auglendshøyden",
    "tjensvoll - dusavik",
    "dusavik - tjensvoll",
  ],
  eiganes: [
    "auglendshøyden - tjensvoll",
    "tjensvoll - auglendshøyden",
    "tjensvoll - madlaveien ved dnb arena",
    "madlaveien ved dnb arena - tjensvoll",
  ],
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

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function scoreTravelFlow(feature) {
  const missingData = Boolean(feature?.missingData);
  const delayedPercent = Number(feature?.delayedPercent);
  const delayAbs = Number.isFinite(delayedPercent) ? Math.abs(delayedPercent) : 0;
  return (missingData ? 0 : 1000) + delayAbs;
}

function classifyTravelFlow(feature) {
  if (!feature || feature.missingData) return null;

  const status = normalizeText(feature.trafficStatusValue);
  const delayedPercent = Number(feature.delayedPercent);

  if (/stationary|stopandgo|closed/.test(status)) return "RED";
  if (/heavy|congested|slow/.test(status)) {
    return Number.isFinite(delayedPercent) && delayedPercent >= 20 ? "RED" : "YELLOW";
  }
  if (/freeflow/.test(status)) {
    if (Number.isFinite(delayedPercent) && delayedPercent >= 20) return "RED";
    if (Number.isFinite(delayedPercent) && delayedPercent >= 8) return "YELLOW";
    return "GREEN";
  }

  if (Number.isFinite(delayedPercent) && delayedPercent >= 20) return "RED";
  if (Number.isFinite(delayedPercent) && delayedPercent >= 8) return "YELLOW";
  if (Number.isFinite(delayedPercent)) return "GREEN";
  return null;
}

function summarizeTravelFlows(features) {
  const byRoute = new Map();

  for (const feature of features || []) {
    const props = feature?.properties || {};
    const route = normalizeText(props.locationDescription);
    if (!route) continue;

    const next = {
      locationDescription: props.locationDescription || "",
      trafficStatusValue: props.trafficStatusValue || "",
      actualTime: props.actualTime,
      expectedTime: props.expectedTime,
      delayedTime: props.delayedTime,
      delayedPercent: props.delayedPercent,
      trendType: props.trendType || "",
      missingData: Boolean(props.missingData),
      updated: props.sistOppdatert || props.publicationTime || "",
    };

    const prev = byRoute.get(route);
    if (!prev || scoreTravelFlow(next) > scoreTravelFlow(prev)) {
      byRoute.set(route, next);
    }
  }

  const result = {};

  for (const tunnelKey of Object.keys(TUNNEL_REGISTRY)) {
    const routeTerms = TRAVEL_TIME_ROUTE_MATCHERS[tunnelKey] || [];
    const candidates = routeTerms
      .map((term) => byRoute.get(term))
      .filter(Boolean)
      .sort((a, b) => scoreTravelFlow(b) - scoreTravelFlow(a));

    const best = candidates[0];
    const level = classifyTravelFlow(best);

    result[tunnelKey] = best && level
      ? {
          source: "travel-time",
          coverage: "nearest-measured-route",
          level,
          routeDescription: best.locationDescription,
          trafficStatusValue: best.trafficStatusValue,
          actualTime: best.actualTime,
          expectedTime: best.expectedTime,
          delayedTime: best.delayedTime,
          delayedPercent: best.delayedPercent,
          trendType: best.trendType,
          updated: best.updated,
        }
      : {
          source: "travel-time",
          coverage: routeTerms.length ? "no-live-data" : "unavailable",
          level: "UNKNOWN",
          routeDescription: best?.locationDescription || "",
          updated: best?.updated || "",
        };
  }

  return result;
}

async function fetchTravelTimeData(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(TRAVEL_TIME_WFS_URL, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Byfjordtunnelen/1.0 (Cloudflare Pages)",
        Accept: "application/json",
      },
      cf: {
        cacheTtl: 60,
        cacheEverything: true,
      },
    });

    if (!response.ok) {
      return summarizeTravelFlows([]);
    }

    const payload = await response.json().catch(() => null);
    return summarizeTravelFlows(payload?.features || []);
  } catch {
    return summarizeTravelFlows([]);
  } finally {
    clearTimeout(timeoutId);
  }
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

  const buildPayload = (messagesClean, travelFlowByTunnel = {}, previousHistory = {}, seedHistory = {}) => {
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
      "fredrikstad",
      "østfold",
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

    const monitoredTunnelKeywords = Object.values(TUNNEL_REGISTRY).flatMap((t) => t.matchTerms);

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

    function messageMatchesTunnel(m, tunnelKey) {
      const tunnel = TUNNEL_REGISTRY[tunnelKey];
      if (!tunnel) return false;
      const txt = `${m.title || ""} ${m.text || ""} ${m.where || ""}`.toLowerCase();
      return tunnel.matchTerms.some((term) => txt.includes(term));
    }

    function isActiveNow(m) {
      const now = Date.now();
      const validityStatus = String(m.validityStatus || "").toLowerCase();
      if (["suspended", "inactive", "closed", "cancelled", "cancelledbyoperator"].includes(validityStatus)) {
        return false;
      }

      const startMs = m.overallStartTime ? Date.parse(m.overallStartTime) : NaN;
      const endMs = m.overallEndTime ? Date.parse(m.overallEndTime) : NaN;

      if (!Number.isNaN(startMs) && now < startMs) return false;
      if (!Number.isNaN(endMs) && now > endMs) return false;
      return true;
    }

    const activeMessages = messagesClean.filter(isActiveNow);
    const stavangerOnly = activeMessages.filter(isStavanger);

    // Fallback hvis tomt, ellers begrens til 25
    const localOnly = stavangerOnly.length ? stavangerOnly.slice(0, 25) : activeMessages.slice(0, 25);

    const nowIso = new Date().toISOString();

    const tunnelHistory = { ...seedHistory, ...previousHistory };
    for (const tunnelKey of Object.keys(TUNNEL_REGISTRY)) {
      const latestClosure = localOnly
        .filter((m) => messageMatchesTunnel(m, tunnelKey) && isClosureMessage(m))
        .map((m) => m.time || nowIso)
        .filter(Boolean)
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

      if (latestClosure) {
        tunnelHistory[tunnelKey] = latestClosure;
      }
    }

    // Byfjord status heuristikk
    const byfjordMsg = localOnly.find((m) => messageMatchesTunnel(m, "byfjord"));
    const byTxt = byfjordMsg ? `${byfjordMsg.title} ${byfjordMsg.text} ${byfjordMsg.where}`.toLowerCase() : "";

    let byStatus = "ÅPEN";
    if (byfjordMsg && /stengt|tunnel stengt|closed|closure/.test(byTxt)) byStatus = "STENGT";
    else if (byfjordMsg && /kolonne|stans|omkjøring|lysregulering|dirigering|redusert/.test(byTxt)) byStatus = "AVVIK";

    return {
      updated: nowIso,
      stavanger: { messages: localOnly },
      travelFlowByTunnel,
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
      tunnels: Object.fromEntries(
        Object.entries(TUNNEL_REGISTRY).map(([key, tunnel]) => [key, { id: tunnel.id, name: tunnel.name }])
      ),
    };
  };

  const cached = await cache.match(cacheKey);
  const historyCached = await cache.match(historyCacheKey);
  const previousHistory = historyCached ? await historyCached.clone().json().catch(() => ({})) : {};
  const seedHistory = normalizeHistorySeed(MANUAL_TUNNEL_HISTORY_SEED);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const [res, travelFlowByTunnel] = await Promise.all([
      fetch(upstream, {
      method: "GET",
      headers,
      signal: controller.signal,
      cf: {
        cacheTtl: 30,
        cacheEverything: true,
      },
      }),
      fetchTravelTimeData(timeoutMs),
    ]);

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

    const payload = { ...buildPayload(messagesClean, travelFlowByTunnel, previousHistory || {}, seedHistory), source: "live", stale: false };
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
    const versionTime = pick(r, "situationRecordVersionTime") || "";
    const validityStatus = pick(r, "validityStatus") || "";
    const overallStartTime = pick(r, "overallStartTime") || "";
    const overallEndTime = pick(r, "overallEndTime") || "";
    const trafficConstrictionType = pick(r, "trafficConstrictionType") || "";
    const roadManagementType = pick(r, "roadOrCarriagewayOrLaneManagementType") || "";

    const where = buildWhere(r);
    const typeMatch = r.match(/<[^:>]*:?situationRecord\b[^>]*\bxsi:type="[^:"]*:([^"]+)"/i);
    const recordType = typeMatch ? typeMatch[1] : "";

    const title = text ? text.split(".")[0].slice(0, 90) : "Trafikkmelding";

    if (!title && !text) continue;

    messages.push({
      title,
      text,
      where,
      severity: severity || "INFO",
      time: created,
      versionTime,
      validityStatus,
      overallStartTime,
      overallEndTime,
      trafficConstrictionType,
      roadManagementType,
      recordType,
    });

    if (messages.length >= 80) break;
  }

  return messages;
}
