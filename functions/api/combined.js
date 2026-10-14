// functions/api/combined.js
import { isClosureMessage } from "../../traffic-rules.js";

const MANUAL_TUNNEL_HISTORY_SEED = {
  byfjord: "2026-02-25T14:45:00+01:00",
  mastrafjord: "",
  eiganes: "",
  hundvag: "",
  ryfast: "",
  finnoy: "",
  talgje: "",
  storhaug: "",
};

export const TUNNEL_REGISTRY = {
  byfjord: { id: "10-8383248394a8c41b", name: "Byfjordtunnelen", matchTerms: ["byfjordtunnelen", "byfjord"] },
  mastrafjord: { id: "10-31b9ef1302194439", name: "Mastrafjordtunnelen", matchTerms: ["mastrafjordtunnelen", "mastrafjord"] },
  eiganes: { id: "10-3e9b280fc15f0540", name: "Eiganestunnelen", matchTerms: ["eiganestunnelen"] },
  hundvag: { id: "10-746700d70a0dd7cd", name: "Hundvågtunnelen", matchTerms: ["hundvågtunnelen", "hundvagtunnelen"] },
  ryfast: { id: "10-e0a2a18ca95b06c6", name: "Ryfylketunnelen", matchTerms: ["ryfylketunnelen", "ryfast"] },
  finnoy: { id: "10-92a98043d0a97d1e", name: "Finnøytunnelen", matchTerms: ["finnøytunnelen", "finnoytunnelen", "finnfast"] },
  talgje: { id: "10-cbdb03f70d66c4c3", name: "Talgjetunnelen", matchTerms: ["talgjetunnelen"] },
  storhaug: { id: "10-201a7ab572b246cd", name: "Storhaugtunnelen", matchTerms: ["storhaugtunnelen"] },
};

export const TOMTOM_FLOW_POINTS = {
  byfjord: { lat: 59.040508, lon: 5.633805 },
  mastrafjord: { lat: 59.080372, lon: 5.690412 },
  // Separate E39 tubes north of the interchange, away from the Hundvag and Madlaveien ramps.
  eiganes: [
    { id: "northbound", label: "Mot Bergen", lat: 58.9704066, lon: 5.7126760 },
    { id: "southbound", label: "Mot sentrum", lat: 58.9704205, lon: 5.7117078 },
  ],
  hundvag: [
    { id: "eastbound", label: "Mot Ryfylke", lat: 58.966268, lon: 5.743592 },
    { id: "westbound", label: "Mot Stavanger", lat: 58.965804, lon: 5.741294 },
  ],
  ryfast: [
    { id: "westbound", label: "Mot Stavanger", lat: 59.0309111, lon: 5.8005237 },
    { id: "eastbound", label: "Mot Ryfylke", lat: 59.0306687, lon: 5.8008061 },
  ],
  finnoy: { lat: 59.1298373, lon: 5.7939422 },
  talgje: { lat: 59.1138372, lon: 5.8018914 },
  storhaug: { lat: 58.961506, lon: 5.752038 },
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

export function classifyTomTomFlow(segment) {
  if (!segment) return "UNKNOWN";
  if (segment.roadClosure) return "RED";

  const currentSpeed = Number(segment.currentSpeed);
  const freeFlowSpeed = Number(segment.freeFlowSpeed);
  const currentTravelTime = Number(segment.currentTravelTime);
  const freeFlowTravelTime = Number(segment.freeFlowTravelTime);

  const speedRatio =
    Number.isFinite(currentSpeed) && Number.isFinite(freeFlowSpeed) && freeFlowSpeed > 0
      ? currentSpeed / freeFlowSpeed
      : null;
  const delayPct =
    Number.isFinite(currentTravelTime) && Number.isFinite(freeFlowTravelTime) && freeFlowTravelTime > 0
      ? ((currentTravelTime - freeFlowTravelTime) / freeFlowTravelTime) * 100
      : null;

  if ((speedRatio !== null && speedRatio <= 0.4) || (delayPct !== null && delayPct >= 50)) return "RED";
  if ((speedRatio !== null && speedRatio <= 0.75) || (delayPct !== null && delayPct >= 20)) return "YELLOW";
  if (speedRatio !== null || delayPct !== null) return "GREEN";
  return "UNKNOWN";
}

export function buildUnknownTomTomFlow(coverage = "unavailable") {
  return {
    source: "tomtom-flow",
    coverage,
    level: "UNKNOWN",
    routeDescription: "",
    currentRoadName: "",
    currentSpeed: null,
    freeFlowSpeed: null,
    currentTravelTime: null,
    freeFlowTravelTime: null,
    confidence: null,
    roadClosure: false,
    updated: "",
  };
}


function getTomTomFlowScore(flow) {
  const levelScore = { UNKNOWN: 0, GREEN: 1, YELLOW: 2, RED: 3 }[flow?.level] || 0;
  const currentSpeed = Number(flow?.currentSpeed);
  const freeFlowSpeed = Number(flow?.freeFlowSpeed);
  const speedLoss = Number.isFinite(currentSpeed) && Number.isFinite(freeFlowSpeed) && freeFlowSpeed > 0
    ? Math.max(0, 1 - currentSpeed / freeFlowSpeed)
    : 0;
  return levelScore * 10 + speedLoss;
}

export function aggregateTomTomFlows(flows) {
  const segments = flows.filter(Boolean);
  const available = segments.filter((flow) => flow.level !== "UNKNOWN");
  if (!available.length) {
    return { ...buildUnknownTomTomFlow("multi-segment-unavailable"), segments };
  }

  const representative = [...available].sort((a, b) => getTomTomFlowScore(b) - getTomTomFlowScore(a))[0];
  return {
    ...representative,
    coverage: "multi-segment",
    segments,
  };
}

async function fetchTomTomTrafficData(env) {
  const apiKey = String(env.TOMTOM_API_KEY || "").trim();
  const unknown = (coverage) => Object.fromEntries(
    Object.keys(TUNNEL_REGISTRY).map(key => [key, buildUnknownTomTomFlow(coverage)])
  );
  if (!apiKey) return unknown("missing-api-key");
  if (!env.TOMTOM_COORDINATOR) return unknown("coordinator-not-configured");
  try {
    return await env.TOMTOM_COORDINATOR.getByName("traffic-api-key-quota").getTraffic(apiKey);
  } catch {
    // Never bypass the central budget after a coordinator failure.
    return unknown("coordinator-unavailable");
  }
}

function getTomTomSourceStatus(travelFlowByTunnel) {
  const points = Object.values(travelFlowByTunnel || {}).flatMap((flow) =>
    Array.isArray(flow?.segments) ? flow.segments : [flow]
  ).filter(Boolean);
  const available = points.filter((flow) => flow.level && flow.level !== "UNKNOWN");
  const stale = available.filter((flow) => flow.coverage === "stale-segment-point" || Date.now() - Date.parse(flow.updated || "") > 20 * 60 * 1000);
  const latestUpdate = available
    .map((flow) => flow.updated)
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || "";

  if (!available.length) {
    return {
      state: "down",
      label: "Utilgjengelig",
      detail: "Ingen TomTom-målepunkter svarer",
      availablePoints: 0,
      totalPoints: points.length,
      updated: "",
    };
  }

  if (stale.length) {
    return {
      state: "degraded",
      label: "Mellomlagret",
      detail: `${stale.length} av ${points.length} målepunkter viser sist kjente verdi`,
      availablePoints: available.length,
      totalPoints: points.length,
      updated: latestUpdate,
    };
  }

  if (available.length < points.length) {
    return {
      state: "degraded",
      label: "Delvis",
      detail: `${available.length} av ${points.length} målepunkter svarer`,
      availablePoints: available.length,
      totalPoints: points.length,
      updated: latestUpdate,
    };
  }

  return {
    state: "ok",
    label: "OK",
    detail: `${available.length} av ${points.length} målepunkter svarer`,
    availablePoints: available.length,
    totalPoints: points.length,
    updated: latestUpdate,
  };
}

function normalizeLookupText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mapPoliceSeverity(message) {
  const txt = normalizeLookupText(`${message?.text || ""} ${message?.area || ""}`);
  if (/stengt|sperr|blokk|personskade|pakjort|nodetat|dirigerer|trafikale utfordringer|store forsinkelser|ko/.test(txt)) {
    return "HIGH";
  }
  if (/ulykke|uhell|berg|trafikk/.test(txt)) {
    return "MEDIUM";
  }
  return "INFO";
}

function isRelevantPoliceTrafficMessage(message) {
  const category = normalizeLookupText(message?.category);
  if (category === "trafikk") return true;

  const txt = normalizeLookupText(`${message?.text || ""} ${message?.area || ""}`);
  return /trafikk|ulykke|uhell|bil|kjoretoy|e39|rv|fv|vei|veg|felt|kryss|pakjort/.test(txt);
}

const RECENT_POLICE_LOOKBACK_MS = 2 * 60 * 60 * 1000;

async function fetchPolitiloggenTrafficMessages(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL("https://api.politiet.no/politiloggen/v1/messages");
    url.searchParams.append("Districts", "SørVest");
    url.searchParams.append("Municipalities", "Stavanger");
    url.searchParams.append("Categories", "Trafikk");
    url.searchParams.append("Categories", "Ulykke");
    url.searchParams.set("DateFrom", new Date(Date.now() - RECENT_POLICE_LOOKBACK_MS).toISOString());
    url.searchParams.set("Take", "30");
    url.searchParams.set("SortBy", "Date");
    url.searchParams.set("SortOrder", "Descending");

    const response = await fetch(url.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": "Byfjordtunnelen/1.0 (Cloudflare Pages)",
        Accept: "application/json",
      },
      cf: {
        cacheTtl: 30,
        cacheEverything: true,
      },
    });

    if (!response.ok) return [];

    const payload = await response.json().catch(() => null);
    const items = Array.isArray(payload?.data) ? payload.data : [];

    return items
      .filter((message) => normalizeLookupText(message?.municipality) === "stavanger")
      .filter(isRelevantPoliceTrafficMessage)
      .slice(0, 10)
      .map((message) => ({
        id: message.id || "",
        title: `Politiet: ${message.category || "Trafikk"}`,
        text: String(message.text || "").trim(),
        where: [message.municipality, message.area].filter(Boolean).join(" • "),
        municipality: message.municipality || "",
        area: message.area || "",
        severity: mapPoliceSeverity(message),
        time: message.updatedOn || message.createdOn || "",
        versionTime: message.updatedOn || "",
        validityStatus: message.isActive ? "active" : "inactive",
        overallStartTime: message.createdOn || "",
        overallEndTime: "",
        trafficConstrictionType: "",
        roadManagementType: "",
        recordType: "PoliceLog",
        sourceType: "police",
        sourceLabel: message.isActive ? "Politiet" : "Politiet • nylig avsluttet",
        isActive: Boolean(message.isActive),
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function onRequest(context) {
  const env = context.env || {};
  const user = env.DATEX_USER;
  const pass = env.DATEX_PASS;

  const timeoutMs = 10000;

  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/combined?region=stavanger", context.request.url).toString(), {
    method: "GET",
  });
  const historyCacheKey = new Request("https://trafikkmeldinger.internal/tunnel-history.json", {
    method: "GET",
  });

  const buildPayload = (messagesClean, travelFlowByTunnel = {}, previousHistory = {}, seedHistory = {}) => {
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
      "rennesøy",
      "finnøy",
      "mosterøy",
      "åmøy",
      "vassøy",
    ];

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

    stavangerMustHave.push("hundvag", "valand", "hillevag", "jatta", "rennesoy", "finnoy", "mosteroy", "amoy", "vassoy");
    stavangerExclude.push("ostfold", "ha");

    const monitoredTunnelKeywords = Object.values(TUNNEL_REGISTRY)
      .flatMap((t) => t.matchTerms)
      .map(normalizeLookupText);

    function isStavanger(m) {
      const t = normalizeLookupText(
        `${m.title || ""} ${m.text || ""} ${m.where || ""} ${m.municipality || ""} ${m.area || ""} ${m.roadName || ""} ${m.roadNumber || ""}`
      );
      const municipality = normalizeLookupText(m.municipality);
      const isMonitoredTunnel = monitoredTunnelKeywords.some((w) => t.includes(w));
      if (isMonitoredTunnel) return true;

      if (municipality && municipality !== "stavanger") return false;

      const hasLocal = stavangerMustHave.some((w) => t.includes(w));
      if (!hasLocal) return false;

      const hasBad = stavangerExclude.some((w) => t.includes(w));
      if (hasBad) return false;

      return true;
    }

    function messageMatchesTunnel(m, tunnelKey) {
      const tunnel = TUNNEL_REGISTRY[tunnelKey];
      if (!tunnel) return false;
      const txt = `${m.title || ""} ${m.text || ""} ${m.where || ""}`.toLowerCase();
      return tunnel.matchTerms.some((term) => txt.includes(term));
    }

    function isActiveNow(m) {
      if (m.isActive === false) return false;

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

    function isRecentPoliceMessage(m) {
      if (m.sourceType !== "police" || m.isActive !== false) return false;

      const eventMs = Date.parse(m.versionTime || m.time || m.overallStartTime || "");
      if (Number.isNaN(eventMs)) return false;

      return Date.now() - eventMs <= RECENT_POLICE_LOOKBACK_MS;
    }

    const activeMessages = messagesClean.filter((m) => isActiveNow(m) || isRecentPoliceMessage(m));
    const stavangerOnly = activeMessages.filter(isStavanger);
    const localOnly = stavangerOnly
      .sort((a, b) => new Date(b.versionTime || b.time || 0).getTime() - new Date(a.versionTime || a.time || 0).getTime());

    const nowIso = new Date().toISOString();
    const tunnelHistory = { ...seedHistory, ...previousHistory };
    for (const tunnelKey of Object.keys(TUNNEL_REGISTRY)) {
      const latestClosure = localOnly
        .filter((m) => messageMatchesTunnel(m, tunnelKey) && isClosureMessage(m))
        .map((m) => m.overallStartTime || m.time || nowIso)
        .filter(Boolean)
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

      if (latestClosure) {
        tunnelHistory[tunnelKey] = latestClosure;
      }
    }

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
  if (cached) {
    const recent = await cached.clone().json().catch(() => null);
    if (recent && !recent.stale && Date.now() - Date.parse(recent.updated || "") < 30000) {
      return json(recent, 200, "public, max-age=15, s-maxage=30");
    }
  }

  try {
    const [res, travelFlowByTunnel, policeMessages] = await Promise.all([
      env.TOMTOM_COORDINATOR
        ? env.TOMTOM_COORDINATOR.getByName("traffic-api-key-quota").getSituation(user, pass)
        : Promise.resolve({ ok: false, status: 503, messages: [] }),
      fetchTomTomTrafficData(env),
      fetchPolitiloggenTrafficMessages(timeoutMs),
    ]);

    if (!res.ok) {
      if (cached) {
        const payload = await cached.json();
        return json(
          {
            ...payload,
            tunnelHistory: payload.tunnelHistory || previousHistory || seedHistory || {},
            sourceStatus: {
              ...(payload.sourceStatus || {}),
              vegvesen: {
                state: "degraded",
                label: "Mellomlagret",
                detail: `DATEX svarer med HTTP ${res.status}; viser sist kjente data`,
                updated: payload.updated || "",
              },
            },
            source: "stale-cache",
            stale: true,
            staleReason: `Upstream ${res.status}`,
          },
          200,
          "public, max-age=10, s-maxage=20, stale-while-revalidate=120"
        );
      }

      return json(
        {
          updated: new Date().toISOString(),
          error: `Upstream ${res.status}`,
        },
        502
      );
    }

    const rawMessages = res.messages || [];
    const messagesClean = coalesceDatexMessages(rawMessages);

    const payload = {
      ...buildPayload([...messagesClean, ...policeMessages], travelFlowByTunnel, previousHistory || {}, seedHistory),
      sourceStatus: {
        vegvesen: {
          state: "ok",
          label: "OK",
          detail: "DATEX-data mottatt fra Statens vegvesen",
          updated: res.updated || new Date().toISOString(),
        },
        tomtom: {
          ...getTomTomSourceStatus(travelFlowByTunnel),
          quotaControlled: Boolean(env.TOMTOM_COORDINATOR),
          refreshMinutes: 15,
          rollingDayBudget: 2000,
        },
      },
      source: "live",
      stale: false,
    };
    const response = json(payload, 200, "public, max-age=15, s-maxage=30, stale-while-revalidate=120");

    const historyResponse = new Response(JSON.stringify(payload.tunnelHistory || {}), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=7200, s-maxage=7200",
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
          sourceStatus: {
            ...(payload.sourceStatus || {}),
            vegvesen: {
              state: "degraded",
              label: "Mellomlagret",
              detail: "DATEX-kontakten feilet; viser sist kjente data",
              updated: payload.updated || "",
            },
          },
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

export function coalesceDatexMessages(messages) {
  const groups = new Map();
  for (const message of messages) {
    const identity = message.situationId || `${message.recordId || ""}|${message.roadManagementType || ""}|${message.text}|${message.where}`;
    const key = `${identity}|${message.where}|${message.validityStatus}|${message.overallStartTime}|${message.overallEndTime}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(message);
  }
  return [...groups.values()].map(records => {
    const closure = records.find(isClosureMessage);
    const representative = closure || records.find(record => record.roadManagementType) || records[0];
    const works = records.some(record => /Works$/.test(record.recordType || ""));
    const eventDescription = works ? "Veiarbeid" : "";
    const comments = [...new Set(records.map(record => record.text).filter(Boolean))];
    const title = closure ? "Stengt vei" : representative.title;
    return {
      ...representative,
      title,
      severity: closure ? "HIGH" : representative.severity,
      sourceType: "datex",
      sourceLabel: "Vegvesen",
      text: [...new Set([closure ? "Stengt vei" : "", eventDescription, ...comments].filter(Boolean))].join(". "),
      eventDescription,
      regulations: [...new Set(records.map(record => record.roadManagementType).filter(Boolean))],
    };
  });
}

export function extractMessagesFromDatex(xml) {
  const situations = xml.match(/<(?:[\w.-]+:)?situation\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?situation>/g) || [xml];
  const records = situations.flatMap(situation => {
    const situationId = situation.match(/^<(?:[\w.-]+:)?situation\b[^>]*\bid="([^"]+)"/)?.[1] || "";
    return (situation.match(/<(?:[\w.-]+:)?situationRecord\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?situationRecord>/g) || [])
      .map(record => ({ record, situationId }));
  });

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
    const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`, "i");
    const m = block.match(re);
    return m ? normalize(m[1]) : "";
  };

  const pickAll = (block, tag) => {
    const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`, "gi");
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
    const roadNumber = pick(r, "roadNumber") || pick(r, "road") || "";
    const roadName = pick(r, "roadName") || pick(r, "roadNameText") || "";
    const locationDesc =
      pick(r, "locationDescription") ||
      pick(r, "locationDescriptionText") ||
      pick(r, "descriptor") ||
      "";
    const direction = pick(r, "direction") || pick(r, "directionOfTravel") || "";

    const placeBits = [
      ...pickAll(r, "name"),
      ...pickAll(r, "tpegDescriptor"),
      ...pickAll(r, "pointDescriptor"),
    ].slice(0, 4);

    return uniqJoin([
      roadNumber,
      roadName,
      direction,
      locationDesc,
      placeBits.join(" "),
    ]).trim();
  };

  const messages = [];
  const localTerms = ["stavanger", ...Object.values(TUNNEL_REGISTRY).flatMap(tunnel => tunnel.matchTerms)];

  for (const { record: r, situationId } of records) {
    // Skip unrelated national records before interpreting every XML field.
    const candidate = r.toLowerCase();
    if (!localTerms.some(term => candidate.includes(term))) continue;
    const commentRaw = pick(r, "comment");
    const text = (commentRaw || "").trim();
    const municipality =
      pick(r, "municipalityName") ||
      pick(r, "municipality") ||
      pick(r, "administrativeAreaName") ||
      "";
    const roadNumber = pick(r, "roadNumber") || pick(r, "road") || "";
    const roadName = pick(r, "roadName") || pick(r, "roadNameText") || "";

    const severity = pick(r, "severity") || pick(r, "impactOnTraffic") || "INFO";
    const created = pick(r, "situationRecordCreationTime") || pick(r, "versionTime") || "";
    const versionTime = pick(r, "situationRecordVersionTime") || "";
    const validityStatus = pick(r, "validityStatus") || "";
    const overallStartTime = pick(r, "overallStartTime") || "";
    const overallEndTime = pick(r, "overallEndTime") || "";
    const trafficConstrictionType = pick(r, "trafficConstrictionType") || "";
    const roadManagementType = pick(r, "roadOrCarriagewayOrLaneManagementType") || "";

    const where = buildWhere(r);
    const typeMatch = r.match(/<(?:[\w.-]+:)?situationRecord\b[^>]*\bxsi:type="[^:"]*:([^"]+)"/i);
    const recordType = typeMatch ? typeMatch[1] : "";
    const title = text ? text.split(".")[0].slice(0, 90) : "Trafikkmelding";

    if (!title && !text) continue;

    messages.push({
      situationId,
      recordId: r.match(/^<[^>]+\bid="([^"]+)"/)?.[1] || "",
      sourceUrl: situationId ? `https://www.vegvesen.no/trafikk/trafikkmeldinger/${encodeURIComponent(situationId)}` : "",
      title,
      text,
      where,
      municipality,
      roadNumber,
      roadName,
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

  }

  return messages;
}
