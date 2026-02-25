// functions/api/combined.js

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

  const headers = {
    "User-Agent": "Byfjordtunnelen/1.0 (Cloudflare Pages)",
  };

  if (user && pass) {
    headers.Authorization = "Basic " + btoa(`${user}:${pass}`);
  }

  const buildPayload = (messagesClean) => {
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
      "finnøy",
      "finnøytunnelen",
      "finnfast",
      "talgje",
      "talgjetunnelen",
      "storhaug",
      "storhaugtunnelen",
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
    };
  };

  const cached = await cache.match(cacheKey);

  if (!user || !pass) {
    return json(
      {
        updated: new Date().toISOString(),
        error: "Missing DATEX credentials",
        message:
          "DATEX_USER and DATEX_PASS must be set in Cloudflare Pages environment variables.",
      },
      503
    );
  }

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
          { ...payload, source: "stale-cache", stale: true, staleReason: `Upstream ${res.status}` },
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

    const payload = { ...buildPayload(messagesClean), source: "live", stale: false };
    const response = json(payload, 200, "public, max-age=15, s-maxage=30, stale-while-revalidate=120");

    if (context.waitUntil) {
      context.waitUntil(cache.put(cacheKey, response.clone()));
    } else {
      await cache.put(cacheKey, response.clone());
    }

    return response;
  } catch (e) {
    if (cached) {
      const payload = await cached.json();
      return json(
        {
          ...payload,
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
