// functions/api/combined.js

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

const TOMTOM_FLOW_POINTS = {
  byfjord: { lat: 59.0248, lon: 5.7265 },
  mastrafjord: { lat: 59.0797, lon: 5.6823 },
  eiganes: { lat: 58.9628, lon: 5.7178 },
  hundvag: { lat: 58.9869, lon: 5.7488 },
  ryfast: { lat: 58.9778, lon: 5.7754 },
  finnoy: { lat: 59.1705, lon: 5.8443 },
  talgje: { lat: 59.145, lon: 5.84 },
  storhaug: { lat: 58.9558, lon: 5.7461 },
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

function classifyTomTomFlow(segment) {
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

function buildUnknownTomTomFlow(coverage = "unavailable") {
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

async function fetchTomTomFlowForPoint(apiKey, point, tunnelKey, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url =
      `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/14/json?key=${encodeURIComponent(apiKey)}` +
      `&point=${point.lat},${point.lon}&unit=KMPH`;
    const response = await fetch(url, {
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

    if (!response.ok) {
      return buildUnknownTomTomFlow("api-error");
    }

    const payload = await response.json().catch(() => null);
    const segment = payload?.flowSegmentData;
    if (!segment || typeof segment !== "object") {
      return buildUnknownTomTomFlow("missing-segment");
    }

    return {
      source: "tomtom-flow",
      coverage: "segment-point",
      level: classifyTomTomFlow(segment),
      routeDescription: segment.currentRoadName || TUNNEL_REGISTRY[tunnelKey]?.name || "",
      currentRoadName: segment.currentRoadName || "",
      currentSpeed: segment.currentSpeed,
      freeFlowSpeed: segment.freeFlowSpeed,
      currentTravelTime: segment.currentTravelTime,
      freeFlowTravelTime: segment.freeFlowTravelTime,
      confidence: segment.confidence,
      roadClosure: Boolean(segment.roadClosure),
      updated: new Date().toISOString(),
    };
  } catch {
    return buildUnknownTomTomFlow("request-failed");
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchTomTomTrafficData(env, timeoutMs) {
  const apiKey = String(env.TOMTOM_API_KEY || "").trim();
  if (!apiKey) {
    return Object.fromEntries(
      Object.keys(TUNNEL_REGISTRY).map((key) => [key, buildUnknownTomTomFlow("missing-api-key")])
    );
  }

  const entries = await Promise.all(
    Object.entries(TUNNEL_REGISTRY).map(async ([tunnelKey]) => {
      const point = TOMTOM_FLOW_POINTS[tunnelKey];
      if (!point) {
        return [tunnelKey, buildUnknownTomTomFlow("unconfigured-point")];
      }
      const flow = await fetchTomTomFlowForPoint(apiKey, point, tunnelKey, timeoutMs);
      return [tunnelKey, flow];
    })
  );

  return Object.fromEntries(entries);
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

    function isClosureMessage(m) {
      const rmt = String(m.roadManagementType || "").toLowerCase();
      if (/roadclosed|carriagewayclosed|carriagewayblocked|laneblocked|roadblocked/.test(rmt)) return true;
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
      .sort((a, b) => new Date(b.time || b.versionTime || 0).getTime() - new Date(a.time || a.versionTime || 0).getTime())
      .slice(0, 50);

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

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const [res, travelFlowByTunnel, policeMessages] = await Promise.all([
      fetch(upstream, {
        method: "GET",
        headers,
        signal: controller.signal,
        cf: {
          cacheTtl: 30,
          cacheEverything: true,
        },
      }),
      fetchTomTomTrafficData(env, timeoutMs),
      fetchPolitiloggenTrafficMessages(timeoutMs),
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
    const seen = new Set();
    const messagesClean = [];
    for (const m of rawMessages) {
      const key = `${(m.text || m.title || "").trim().toLowerCase()}|${(m.where || "").trim().toLowerCase()}`;
      if (!key.trim()) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      messagesClean.push(m);
    }

    const payload = {
      ...buildPayload([...messagesClean, ...policeMessages], travelFlowByTunnel, previousHistory || {}, seedHistory),
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

  for (const r of records) {
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
    const typeMatch = r.match(/<[^:>]*:?situationRecord\b[^>]*\bxsi:type="[^:"]*:([^"]+)"/i);
    const recordType = typeMatch ? typeMatch[1] : "";
    const title = text ? text.split(".")[0].slice(0, 90) : "Trafikkmelding";

    if (!title && !text) continue;

    messages.push({
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

    if (messages.length >= 80) break;
  }

  return messages;
}
