(() => {
  const el = (id) => document.getElementById(id);

  const CONFIG = {
    api: "/api/combined?region=stavanger",
    weatherApi: "https://api.met.no/weatherapi/locationforecast/2.0/compact",
    weatherLat: 59.0369,
    weatherLon: 5.7331,
    refreshRate: 60000,
    clockRate: 1000,
    weatherRefreshRate: 600000,
    retryDelay: 5000,
    maxRetries: 3,
    apiTimeoutMs: 10000,
    offlineCacheKey: "byfjord:lastPayload",
    tunnelHistoryCacheKey: "byfjord:lastClosedByTunnel"
  };

  const TUNNELS = {
    byfjord: { id: "10-8383248394a8c41b", name: "Byfjordtunnelen", keywords: ["byfjordtunnelen", "byfjord"], length: 5875 },
    mastrafjord: { id: "10-31b9ef1302194439", name: "Mastrafjordtunnelen", keywords: ["mastrafjordtunnelen", "mastrafjord"], length: 4424 },
    eiganes: { id: "10-3e9b280fc15f0540", name: "Eiganestunnelen", keywords: ["eiganestunnelen"], length: 3174 },
    hundvag: { id: "10-746700d70a0dd7cd", name: "Hundvågtunnelen", keywords: ["hundvågtunnelen", "hundvagtunnelen"], length: 2100 },
    ryfast: { id: "10-e0a2a18ca95b06c6", name: "Ryfylketunnelen", keywords: ["ryfylketunnelen", "ryfast"], length: 14300 },
    finnoy: { id: "10-92a98043d0a97d1e", name: "Finnøytunnelen", keywords: ["finnøytunnelen", "finnoytunnelen", "finnfast"], length: 5685 },
    talgje: { id: "10-cbdb03f70d66c4c3", name: "Talgjetunnelen", keywords: ["talgjetunnelen"], length: 1467 },
    storhaug: { id: "10-201a7ab572b246cd", name: "Storhaugtunnelen", keywords: ["storhaugtunnelen"], length: 1100 }
  };

  const STATE = {
    retryCount: 0,
    lastSuccessfulUpdate: null,
    isRefreshing: false,
    tunnelStatuses: {},
    tunnelTrafficFlow: {},
    allMessages: [],
    messagesByTunnel: {},
    scheduledRetryId: null,
    lastClosedAtByTunnel: {}
  };

  const dom = {
    app: el("app"),
    updated: el("updated"),
    clock: el("clock"),
    items: el("items"),
    health: el("health"),
    eventCount: el("eventCount"),
    weather: el("weather"),
    weatherText: el("weatherText"),
    tunnelsGrid: el("tunnelsGrid")
  };

  Object.keys(TUNNELS).forEach(key => { STATE.tunnelStatuses[key] = "ÅPEN"; });
  STATE.lastClosedAtByTunnel = readTunnelHistory();

  Object.keys(TUNNELS).forEach(key => {
    STATE.tunnelTrafficFlow[key] = { level: "UNKNOWN", source: "unavailable", coverage: "unavailable" };
  });

  function readOfflineCache() {
    try {
      const raw = localStorage.getItem(CONFIG.offlineCacheKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeOfflineCache(payload) {
    try {
      localStorage.setItem(CONFIG.offlineCacheKey, JSON.stringify(payload));
    } catch {
      // Ignore cache write failures (private mode/quota)
    }
  }


  function readTunnelHistory() {
    try {
      const raw = localStorage.getItem(CONFIG.tunnelHistoryCacheKey);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeTunnelHistory(history) {
    try {
      localStorage.setItem(CONFIG.tunnelHistoryCacheKey, JSON.stringify(history));
    } catch {
      // Ignore cache write failures (private mode/quota)
    }
  }

  function updateGlobalTheme() {
    if (!dom.app) return;
    const hasClosed = Object.values(STATE.tunnelStatuses).some(s => s === "STENGT");
    const hasWarning = Object.values(STATE.tunnelStatuses).some(s => s === "AVVIK");
    
    dom.app.classList.remove("good", "bad", "warn");
    if (hasClosed) dom.app.classList.add("bad");
    else if (hasWarning) dom.app.classList.add("warn");
    else dom.app.classList.add("good");
  }

  function fmtTime(iso) {
    try {
      if (!iso) return "--:--";
      return new Date(iso).toLocaleTimeString("no-NO", { hour: "2-digit", minute: "2-digit" });
    } catch { return "--:--"; }
  }

  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }


  function isClosureMessage(msg) {
    const txt = `${msg?.title || ""} ${msg?.text || ""}`.toLowerCase();
    return /stengt|steng[te]|closed?|closure|sperr[et]|blocked?|impassable|ikke farbar/.test(txt);
  }

  function fmtClosedTime(iso) {
    try {
      if (!iso) return "Ukjent";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "Ukjent";

      return d.toLocaleString("no-NO", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch {
      return "Ukjent";
    }
  }

  function getTunnelMetaText(messages) {
    if (!messages.length) return "Ingen aktiv melding";

    const primary = messages[0];
    if (primary?.overallEndTime) {
      return `Gyldig til: ${fmtClosedTime(primary.overallEndTime)}`;
    }

    const updatedAt = primary?.versionTime || primary?.time;
    if (updatedAt) {
      return `Oppdatert: ${fmtClosedTime(updatedAt)}`;
    }

    return "Aktiv melding";
  }

  async function loadWeather() {
    try {
      const response = await fetch(`${CONFIG.weatherApi}?lat=${CONFIG.weatherLat}&lon=${CONFIG.weatherLon}`, {
        headers: { 'User-Agent': 'Byfjordtunnelen/2.0 (trafikkmeldinger.pages.dev)' }
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      const current = data.properties?.timeseries?.[0];
      if (current?.data?.instant?.details) {
        const temp = current.data.instant.details.air_temperature;
        if (dom.weatherText) dom.weatherText.textContent = `${Math.round(temp)}°C`;
        if (dom.weather) dom.weather.style.display = "flex";
      }
    } catch (err) {
      if (dom.weather) dom.weather.style.display = "none";
    }
  }

  function updateHealth(isHealthy, message) {
    if (dom.health) {
      dom.health.innerHTML = `<span class="healthDot ${isHealthy ? 'healthy' : 'unhealthy'}"></span>${message || 'System status: OK'}`;
    }
  }

  function isRelevantToTunnel(message, tunnelKey) {
    const tunnel = TUNNELS[tunnelKey];
    if (!tunnel) return false;
    const text = `${message.title || ""} ${message.text || ""} ${message.where || ""}`.toLowerCase();
    const keywordHit = tunnel.keywords.some(keyword => text.includes(keyword));
    if (!keywordHit) return false;

    // Avoid false positives for area names (e.g. "Eiganes") when the event is not tunnel-specific.
    if (tunnelKey === "eiganes" && text.includes("eiganes") && !text.includes("eiganestunnelen")) {
      const hasTunnelWord = /tunnel|tunell/.test(text);
      if (!hasTunnelWord) return false;
    }

    return true;
  }

  function isMessageActiveNow(message) {
    const validityStatus = String(message.validityStatus || "").toLowerCase();
    if (["suspended", "inactive", "closed", "cancelled", "cancelledbyoperator"].includes(validityStatus)) {
      return false;
    }

    const now = Date.now();
    const startMs = message.overallStartTime ? Date.parse(message.overallStartTime) : NaN;
    const endMs = message.overallEndTime ? Date.parse(message.overallEndTime) : NaN;

    if (!Number.isNaN(startMs) && now < startMs) return false;
    if (!Number.isNaN(endMs) && now > endMs) return false;
    return true;
  }

  function determineTunnelStatus(messages, tunnelKey) {
    const relevantMessages = messages
      .filter(msg => isRelevantToTunnel(msg, tunnelKey))
      .filter(msg => isMessageActiveNow(msg))
      .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
    if (relevantMessages.length === 0) return "ÅPEN";

    // Check severity first (most reliable indicator)
    for (const msg of relevantMessages) {
      const sev = String(msg.severity || "").toUpperCase();
      if ((sev === "HIGHEST" || sev === "HIGH") && isClosureMessage(msg)) {
        return "STENGT";
      }
    }

    // Check for closure/severe disruption patterns
    for (const msg of relevantMessages) {
      if (isClosureMessage(msg)) {
        return "STENGT";
      }
    }

    // Check for disruptions/warnings (AVVIK)
    for (const msg of relevantMessages) {
      const txt = `${msg.title} ${msg.text}`.toLowerCase();
      if (/kolonne|stans|omkjøring|lysregulering|dirigering|redusert|kø|ulykke|accident|delay|trafikkulykke|framkommelighet/.test(txt)) {
        return "AVVIK";
      }
    }

    return "ÅPEN";
  }

  function determineTrafficFlow(messages, tunnelKey) {
    const relevantMessages = messages
      .filter(msg => isRelevantToTunnel(msg, tunnelKey))
      .filter(msg => isMessageActiveNow(msg))
      .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));

    if (relevantMessages.length === 0) return "GREEN";

    for (const msg of relevantMessages) {
      const txt = `${msg.title || ""} ${msg.text || ""}`.toLowerCase();
      if (/stillest[åa]ende|sv[æa]rt tett trafikk|lange k[øo]er|lang k[øo]|k[øo] over|store forsinkelser|betydelig forsinkelse|sakteg[åa]ende/.test(txt)) {
        return "RED";
      }
    }

    for (const msg of relevantMessages) {
      const txt = `${msg.title || ""} ${msg.text || ""}`.toLowerCase();
      if (/k[øo]|tett trafikk|forsinkelse|redusert hastighet|redusert framkommelighet|framkommelighet|ulykke|trafikkulykke|kolonne|lysregulering|dirigering|stans/.test(txt)) {
        return "YELLOW";
      }
    }

    return "GREEN";
  }

  function getTrafficFlowMeta(flow) {
    switch (flow) {
      case "RED":
        return { className: "traffic-red", label: "Rød", description: "Treg eller tett trafikk" };
      case "YELLOW":
        return { className: "traffic-yellow", label: "Gul", description: "Noe treg trafikk" };
      default:
        return { className: "traffic-green", label: "Grønn", description: "Normal flyt" };
    }
  }

  function getTrafficFlowDisplayMeta(flow) {
    switch (flow) {
      case "RED":
        return {
          className: "traffic-red",
          level: "Høy",
          icon: "🔴",
          description: "Høy trafikkbelastning med treg eller tett trafikk"
        };
      case "YELLOW":
        return {
          className: "traffic-yellow",
          level: "Middels",
          icon: "🟡",
          description: "Middels trafikkbelastning med noe treg flyt"
        };
      default:
        return {
          className: "traffic-green",
          level: "Lav",
          icon: "🟢",
          description: "Lav trafikkbelastning og normal flyt"
        };
    }
  }

  function normalizeTrafficFlow(flow) {
    if (!flow || typeof flow !== "object") {
      return { level: "UNKNOWN", source: "unavailable", coverage: "unavailable" };
    }

    return {
      level: flow.level || "UNKNOWN",
      source: flow.source || "travel-time",
      coverage: flow.coverage || "unavailable",
      routeDescription: flow.routeDescription || "",
      trafficStatusValue: flow.trafficStatusValue || "",
      actualTime: flow.actualTime,
      expectedTime: flow.expectedTime,
      delayedTime: flow.delayedTime,
      delayedPercent: flow.delayedPercent,
      trendType: flow.trendType || "",
      updated: flow.updated || ""
    };
  }

  function fmtDurationSeconds(seconds) {
    const total = Number(seconds);
    if (!Number.isFinite(total)) return "";
    const mins = Math.floor(total / 60);
    const secs = Math.abs(total % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }

  function getRealTrafficFlowDisplayMeta(flow) {
    switch (flow?.level) {
      case "RED":
        return {
          className: "traffic-red",
          level: "Høy",
          icon: "🔴",
          description: "Høy trafikkbelastning basert på reisetidsdata"
        };
      case "YELLOW":
        return {
          className: "traffic-yellow",
          level: "Middels",
          icon: "🟡",
          description: "Middels trafikkbelastning basert på reisetidsdata"
        };
      case "UNKNOWN":
        return {
          className: "traffic-unknown",
          level: "Ingen data",
          icon: "⚪",
          description: "Ingen sanntidsmåling fra Vegvesenet for denne tunnelen"
        };
      default:
        return {
          className: "traffic-green",
          level: "Lav",
          icon: "🟢",
          description: "Lav trafikkbelastning basert på reisetidsdata"
        };
    }
  }

  function getTrafficFlowDetails(flow) {
    if (!flow || flow.level === "UNKNOWN") {
      return "Ingen sanntidsmåling tilgjengelig i Vegvesenets reisetidsfeed.";
    }

    const parts = [];
    if (flow.routeDescription) {
      parts.push(`Målt via ${flow.routeDescription}.`);
    }

    const actual = fmtDurationSeconds(flow.actualTime);
    const expected = fmtDurationSeconds(flow.expectedTime);
    if (actual && expected) {
      parts.push(`Reisetid ${actual} mot normalt ${expected}.`);
    }

    const delayedPercent = Number(flow.delayedPercent);
    if (Number.isFinite(delayedPercent)) {
      const sign = delayedPercent > 0 ? "+" : "";
      parts.push(`${sign}${delayedPercent}% mot referanse.`);
    }

    return parts.join(" ");
  }

  function updateTunnelClosureHistory(defaultTimeIso) {
    const nextHistory = { ...STATE.lastClosedAtByTunnel };

    for (const tunnelKey of Object.keys(TUNNELS)) {
      const messages = STATE.messagesByTunnel[tunnelKey] || [];
      const closureCandidates = messages
        .filter((msg) => isClosureMessage(msg))
        .map((msg) => msg.time || defaultTimeIso)
        .filter(Boolean)
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

      if (closureCandidates.length > 0) {
        nextHistory[tunnelKey] = closureCandidates[0];
      }
    }

    STATE.lastClosedAtByTunnel = nextHistory;
    writeTunnelHistory(nextHistory);
  }

  function rebuildTunnelMessageIndex(messages) {
    const next = {};
    for (const tunnelKey of Object.keys(TUNNELS)) {
      next[tunnelKey] = messages.filter((msg) => isRelevantToTunnel(msg, tunnelKey));
    }
    STATE.messagesByTunnel = next;
  }

  function renderTunnelsGrid() {
    if (!dom.tunnelsGrid) return;
    
    const html = Object.entries(TUNNELS).map(([key, tunnel]) => {
      const trafficFlow = normalizeTrafficFlow(STATE.tunnelTrafficFlow[key]);
      const trafficMeta = getRealTrafficFlowDisplayMeta(trafficFlow);
      const status = STATE.tunnelStatuses[key] || "ÅPEN";
      const statusClass = 
        status === "ÅPEN" ? "status-open" :
        status === "STENGT" ? "status-closed" : "status-warning";
      
      const statusText = 
        status === "ÅPEN" ? "Åpen" :
        status === "STENGT" ? "Stengt" : "Avvik";
      
      const tunnelMessages = STATE.messagesByTunnel[key] || [];
      const reason = tunnelMessages.length > 0 
        ? (tunnelMessages[0].text || tunnelMessages[0].title)
        : "Ingen merknader";
      
      const lengthText = tunnel.length > 0 ? `${(tunnel.length/1000).toFixed(1)} km` : "";
      const tunnelMetaText = getTunnelMetaText(tunnelMessages);

      return `
        <div class="tunnelItem ${statusClass}">
          <div class="tunnelItemHeader">
            <div class="tunnelItemStatus">
              <div class="statusDot ${statusClass}"></div>
              <span class="statusLabel">${statusText}</span>
            </div>
            <span class="tunnelTime">${tunnelMetaText}</span>
          </div>
          <h3 class="tunnelItemName">${tunnel.name}</h3>
          ${lengthText ? `<div class="tunnelItemLength">${lengthText}</div>` : ''}
          <div class="trafficFlowRow">
            <span class="trafficFlowLabel">Trafikkflyt</span>
            <span class="trafficFlowBadge ${trafficMeta.className}">
              <span class="trafficFlowIcon" aria-hidden="true">${trafficMeta.icon}</span>
              <span class="trafficFlowLevel">${trafficMeta.level}</span>
            </span>
          </div>
          <div class="trafficFlowText">${trafficMeta.description}</div>
          <div class="trafficFlowText trafficFlowDataText">${esc(getTrafficFlowDetails(trafficFlow))}</div>
          <div class="tunnelItemReason">${esc(reason)}</div>
        </div>
      `;
    }).join("");
    
    dom.tunnelsGrid.innerHTML = html;
  }

  async function load() {
    if (STATE.isRefreshing) return;
    STATE.isRefreshing = true;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.apiTimeoutMs);
      const response = await fetch(CONFIG.api, { cache: "no-store", signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      if (data.error) {
        console.error("API error:", data.error, data.message);
        updateHealth(false, `API-feil: ${data.error}`);
        STATE.isRefreshing = false;
        return;
      }

      STATE.retryCount = 0;
      if (STATE.scheduledRetryId) {
        clearTimeout(STATE.scheduledRetryId);
        STATE.scheduledRetryId = null;
      }
      STATE.lastSuccessfulUpdate = new Date();
      STATE.allMessages = data.stavanger?.messages || [];
      rebuildTunnelMessageIndex(STATE.allMessages);
      if (data.source !== "stale-cache") {
        writeOfflineCache(data);
      }

      Object.keys(TUNNELS).forEach(tunnelKey => {
        STATE.tunnelStatuses[tunnelKey] = determineTunnelStatus(STATE.allMessages, tunnelKey);
        STATE.tunnelTrafficFlow[tunnelKey] = normalizeTrafficFlow(data.travelFlowByTunnel?.[tunnelKey]);
      });
      if (data.tunnelHistory && typeof data.tunnelHistory === "object") {
        STATE.lastClosedAtByTunnel = { ...data.tunnelHistory };
        writeTunnelHistory(STATE.lastClosedAtByTunnel);
      } else {
        updateTunnelClosureHistory(data.updated);
      }

      renderTunnelsGrid();
      updateGlobalTheme();

      const updatedStr = fmtTime(data.updated);
      if (dom.updated) dom.updated.textContent = `Oppdatert: ${updatedStr}`;

      if (dom.eventCount) {
        const count = STATE.allMessages.length;
        dom.eventCount.textContent = count > 0 
          ? `${count} ${count === 1 ? 'hendelse' : 'hendelser'}`
          : 'Ingen hendelser';
      }

      if (dom.items) {
        if (!STATE.allMessages.length) {
          dom.items.innerHTML = `
            <div class="emptyState">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
              </svg>
              <div>Ingen aktive hendelser</div>
              <div class="emptyStateText">Alle veier i Stavanger-regionen er åpne</div>
            </div>`;
        } else {
          dom.items.innerHTML = STATE.allMessages.map((m, index) => {
            const sev = String(m.severity || "").toUpperCase();
            const cls = sev === "HIGH" || sev === "HIGHEST" ? "bad" : sev === "MEDIUM" ? "warn" : "info";
            const severityIcon = sev === "HIGH" || sev === "HIGHEST" ? 
              `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>` :
              sev === "MEDIUM" ?
              `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>` :
              `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
            const whereLine = m.where ? `<div class="itemWhere">${esc(m.where)}</div>` : "";
            return `
              <div class="item ${cls}" style="animation-delay: ${index * 0.1}s">
                <div class="itemIcon">${severityIcon}</div>
                <div class="itemMain">
                  <div class="itemTitle">${esc(m.title)}</div>
                  ${whereLine}
                  <div class="itemText">${esc(m.text)}</div>
                </div>
              </div>`;
          }).join("");
        }
      }

      if (data.stale) {
        updateHealth(false, "Ustabil API-kontakt (viser cache fra server)");
      } else {
        updateHealth(true, "System status: OK");
      }

    } catch (err) {
      STATE.retryCount++;
      console.error("Data fetch error:", err);

      if (STATE.retryCount < CONFIG.maxRetries) {
        updateHealth(false, `Kobler til på nytt... (${STATE.retryCount}/${CONFIG.maxRetries})`);
        STATE.scheduledRetryId = setTimeout(() => load(), CONFIG.retryDelay);
      } else {
        const cached = readOfflineCache();
        if (cached?.stavanger?.messages) {
          STATE.allMessages = cached.stavanger.messages;
          rebuildTunnelMessageIndex(STATE.allMessages);
          Object.keys(TUNNELS).forEach(tunnelKey => {
            STATE.tunnelStatuses[tunnelKey] = determineTunnelStatus(STATE.allMessages, tunnelKey);
            STATE.tunnelTrafficFlow[tunnelKey] = normalizeTrafficFlow(cached.travelFlowByTunnel?.[tunnelKey]);
          });
          updateTunnelClosureHistory(cached.updated);
          renderTunnelsGrid();
          updateGlobalTheme();
          updateHealth(false, "Ingen forbindelse til API (viser sist lagrede data)");
          if (dom.updated && cached.updated) {
            dom.updated.textContent = `Oppdatert: ${fmtTime(cached.updated)} (cache)`;
          }
        } else {
          updateHealth(false, "Ingen forbindelse til API");
        }
        setTimeout(() => { STATE.retryCount = 0; }, 30000);
      }
    } finally {
      STATE.isRefreshing = false;
    }
  }

  function tick() {
    if (dom.clock) {
      dom.clock.textContent = new Date().toLocaleTimeString("no-NO", { 
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
    }
  }

  // Initialize
  tick();
  setInterval(tick, CONFIG.clockRate);
  load();
  setInterval(load, CONFIG.refreshRate);
  loadWeather();
  setInterval(loadWeather, CONFIG.weatherRefreshRate);
})();
