// functions/api/combined.js

export async function onRequest(context) {
  const env = context.env || {};
  const user = env.DATEX_USER;
  const pass = env.DATEX_PASS;

  const upstream =
    "https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi/GetSituation/pullsnapshotdata";

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
    const headers = {
      "User-Agent": "Byfjordtunnelen/1.0 (Cloudflare Pages)",
      Authorization: "Basic " + btoa(`${user}:${pass}`),
    };

    const res = await fetch(upstream, {
      method: "GET",
      headers,
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    const xml = await res.text();

    if (!res.ok) {
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

  // Tunneler vi viser status for
  "mastrafjord",
  "mastra",
  "ryfast",
  "ryfylke",
  "ryfylketunnelen",
  "solbakk",
  "solbakktunnelen",
  "eiganestunnelen",
  "hundvågtunnelen",
  "storhaugtunnelen"
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
  "skaun"
];

function isStavanger(m) {
  const t = `${m.title || ""} ${m.text || ""} ${m.where || ""}`.toLowerCase();

  const hasLocal = stavangerMustHave.some((w) => t.includes(w));
  if (!hasLocal) return false;

  const hasBad = stavangerExclude.some((w) => t.includes(w));
  if (hasBad) return false;

  return true;
}

    const stavangerOnly = messagesClean.filter(isStavanger);

    // Fallback hvis tomt, ellers begrens til 25
    const localOnly = stavangerOnly.length ? stavangerOnly.slice(0, 25) : messagesClean.slice(0, 25);

    const nowIso = new Date().toISOString();

    // Byfjord status heuristikk
    const byfjordMsg = localOnly.find((m) => `${m.title} ${m.text} ${m.where}`.toLowerCase().includes("byfjord"));
    const byTxt = byfjordMsg ? `${byfjordMsg.title} ${byfjordMsg.text} ${byfjordMsg.where}`.toLowerCase() : "";

    let byStatus = "ÅPEN";
    if (byfjordMsg && /stengt|tunnel stengt|closed|closure/.test(byTxt)) byStatus = "STENGT";
    else if (byfjordMsg && /kolonne|stans|omkjøring|lysregulering|dirigering|redusert/.test(byTxt)) byStatus = "AVVIK";

    const payload = {
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

    return json(payload, 200);
  } catch (e) {
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

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
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
