import { isClosureMessage, isPartialClosure, measurementAge } from "./traffic-rules.js";

(() => {
  const el = (id) => document.getElementById(id);
  const previewApiOrigin = location.hostname.endsWith(".trafikkmeldinger.pages.dev")
    ? "https://trafikkmeldinger.pages.dev"
    : "";

  const CONFIG = {
    api: `${previewApiOrigin}/api/combined?region=stavanger`,
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

  const OSLO = "Europe/Oslo";
  const TUNNELS = {
    byfjord: { id: "10-8383248394a8c41b", name: "Byfjordtunnelen", keywords: ["byfjordtunnelen", "byfjord"], length: 5875, speedLimit: 80, cameras: [{ id: "byfjord_nord", label: "Mot Stavanger/Randaberg" }, { id: "byfjord_sor", label: "Mot innløpet retning nord" }] },
    mastrafjord: { id: "10-31b9ef1302194439", name: "Mastrafjordtunnelen", keywords: ["mastrafjordtunnelen", "mastrafjord"], length: 4424, speedLimit: 80, cameras: [] },
    eiganes: { id: "10-3e9b280fc15f0540", name: "Eiganestunnelen", keywords: ["eiganestunnelen"], length: 3700, speedLimit: 80, cameras: [{ id: "eiganes_e39", label: "E39 mot Sandnes" }, { id: "eiganes", label: "Retning Sentrum" }] },
    hundvag: { id: "10-746700d70a0dd7cd", name: "Hundvågtunnelen", keywords: ["hundvågtunnelen", "hundvagtunnelen"], length: 5700, speedLimit: 80, cameras: [{ id: "hundvag_sandnes", label: "Utløp Hundvåg/Eiganes mot Sandnes" }] },
    ryfast: { id: "10-e0a2a18ca95b06c6", name: "Ryfylketunnelen", keywords: ["ryfylketunnelen", "ryfast"], length: 14300, speedLimit: 80, cameras: [] },
    finnoy: { id: "10-92a98043d0a97d1e", name: "Finnøytunnelen", keywords: ["finnøytunnelen", "finnoytunnelen", "finnfast"], length: 5685, speedLimit: 80, cameras: [] },
    talgje: { id: "10-cbdb03f70d66c4c3", name: "Talgjetunnelen", keywords: ["talgjetunnelen"], length: 1467, speedLimit: 80, cameras: [] },
    storhaug: { id: "10-201a7ab572b246cd", name: "Storhaugtunnelen", keywords: ["storhaugtunnelen"], length: 1100, speedLimit: 50, cameras: [] }
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
    lastClosedAtByTunnel: {},
    progressAnimId: null,
    cameraRefreshId: null,
    statusFresh: false
  };

  const dom = {
    app: el("app"),
    updated: el("updated"),
    clock: el("clock"),
    date: el("date"),
    items: el("items"),
    vegvesenHealth: el("vegvesenHealth"),
    tomtomHealth: el("tomtomHealth"),
    eventCount: el("eventCount"),
    weather: el("weather"),
    weatherText: el("weatherText"),
    weatherIcon: el("weatherIcon"),
    weatherWind: el("weatherWind"),
    progressFill: el("progressFill"),
    tunnelsGrid: el("tunnelsGrid"),
    overviewSignal: el("overviewSignal"),
    overviewTitle: el("overviewTitle"),
    overviewSub: el("overviewSub"),
    summaryFlow: el("summaryFlow"),
    summaryFlowDetail: el("summaryFlowDetail"),
    summaryEvents: el("summaryEvents"),
    summaryEventDetail: el("summaryEventDetail"),
    summaryDelay: el("summaryDelay"),
    summaryDelayDetail: el("summaryDelayDetail")
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

  const STATUS_CLASS = { "ÅPEN": "status-open", "STENGT": "status-closed", "AVVIK": "status-warning" };

  function msgKey(m) {
    return `${m.time || ""}|${(m.title || "").trim()}|${(m.text || "").trim()}`;
  }

  function messageItemHtml(m) {
    const sev = String(m.severity || "").toUpperCase();
    const cls = (sev === "HIGH" || sev === "HIGHEST") ? "bad" : sev === "MEDIUM" ? "warn" : "info";
    const icon = (sev === "HIGH" || sev === "HIGHEST")
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
      : sev === "MEDIUM"
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
    const body = esc(m.text || m.title || "");
    const source = m.sourceLabel ? `<span class="msgSource">${esc(m.sourceLabel)}</span>` : "";
    return `<div class="msgItem ${cls}"><span class="msgIcon ${cls}">${icon}</span><div class="msgBody"><div class="msgText">${body}</div>${source}</div></div>`;
  }

  function getRelevantEventCount() {
    const relevant = new Set();
    Object.values(STATE.messagesByTunnel).forEach(msgs =>
      msgs.filter(isMessageActiveNow).forEach(message => relevant.add(msgKey(message)))
    );
    return relevant.size;
  }

  function hasAnyRelevantMessages() {
    return getRelevantEventCount() > 0;
  }

  function updateRightPanel() {
    if (hasAnyRelevantMessages()) {
      stopCameraRefresh();
      renderMessagePanel();
      return;
    }
    renderStaticCameraPanel();
  }

  function renderMessagePanel() {
    if (!dom.items) return;

    // Build tunnel groups — messages that match a specific tunnel
    const groups = [];
    for (const [key, tunnel] of Object.entries(TUNNELS)) {
      const msgs = (STATE.messagesByTunnel[key] || []).filter(m => isMessageActiveNow(m));
      if (msgs.length > 0) {
        groups.push({ key, tunnel, msgs });
      }
    }

    if (dom.eventCount) {
      const n = getRelevantEventCount();
      dom.eventCount.textContent = n > 0 ? `${n} ${n === 1 ? "hendelse" : "hendelser"}` : "Ingen tunnelhendelser";
    }

    let html = "";

    for (const { key, tunnel, msgs } of groups) {
      const dotCls = STATUS_CLASS[STATE.tunnelStatuses[key]] || "status-open";
      html += `
        <div class="tunnelGroup">
          <div class="tunnelGroupHeader">
            <div class="tunnelGroupDot ${dotCls}"></div>
            ${esc(tunnel.name)}
          </div>
          <div class="tunnelGroupItems">
            ${msgs.map(m => messageItemHtml(m)).join("")}
          </div>
        </div>`;
    }

    dom.items.innerHTML = `<div class="activeMessages">${html}</div>${cameraPanelHtml()}`;
    bindCameraImages();
    startCameraRefresh();
  }

  function startProgressCountdown() {
    if (!dom.progressFill) return;
    if (STATE.progressAnimId) cancelAnimationFrame(STATE.progressAnimId);
    const startTime = Date.now();
    const duration = CONFIG.refreshRate;
    const animate = () => {
      const pct = Math.max(0, 100 - ((Date.now() - startTime) / duration * 100));
      dom.progressFill.style.width = pct + "%";
      if (pct > 0) STATE.progressAnimId = requestAnimationFrame(animate);
    };
    STATE.progressAnimId = requestAnimationFrame(animate);
  }

  function getWeatherIcon(symbolCode) {
    if (!symbolCode) return "";
    const base = symbolCode.replace(/_(day|night|polartwilight)$/, "");
    const map = {
      clearsky: "☀️", fair: "🌤️", partlycloudy: "⛅", cloudy: "☁️",
      fog: "🌫️", lightfog: "🌫️",
      lightrain: "🌦️", rain: "🌧️", heavyrain: "🌧️",
      lightrainshowers: "🌦️", rainshowers: "🌧️", heavyrainshowers: "🌧️",
      lightsleet: "🌨️", sleet: "🌨️", heavysleet: "🌨️",
      lightsleetshowers: "🌨️", sleetshowers: "🌨️",
      lightsnow: "❄️", snow: "❄️", heavysnow: "❄️",
      lightsnowshowers: "❄️", snowshowers: "❄️",
      thunder: "⛈️", lightrainandthunder: "⛈️", rainandthunder: "⛈️",
      heavyrainandthunder: "⛈️", snowandthunder: "⛈️",
      lightrainshowersandthunder: "⛈️", rainshowersandthunder: "⛈️"
    };
    return map[base] || "🌡️";
  }

  function updateGlobalTheme() {
    if (!dom.app) return;
    const hasClosed = Object.values(STATE.tunnelStatuses).some(s => s === "STENGT");
    const hasWarning = !STATE.statusFresh || Object.values(STATE.tunnelStatuses).some(s => s === "AVVIK") ||
      Object.values(STATE.tunnelTrafficFlow).some(flow => normalizeTrafficFlow(flow).roadClosure);
    
    dom.app.classList.remove("good", "bad", "warn");
    if (hasClosed) dom.app.classList.add("bad");
    else if (hasWarning) dom.app.classList.add("warn");
    else dom.app.classList.add("good");
  }

  function fmtTime(iso) {
    try {
      if (!iso) return "--:--";
      return new Date(iso).toLocaleTimeString("no-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" });
    } catch { return "--:--"; }
  }

  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function getAllCameraSources() {
    const t = Date.now();
    const cameras = [];
    const cameraOrder = ["hundvag", "byfjord", "eiganes"];
    for (const tunnelKey of cameraOrder) {
      const tunnel = TUNNELS[tunnelKey];
      if (!Array.isArray(tunnel.cameras)) continue;
      for (const cam of tunnel.cameras) {
        cameras.push({ ...cam, tunnelName: tunnel.name, src: `/api/cam?id=${encodeURIComponent(cam.id)}&t=${t}` });
      }
    }
    return cameras;
  }

  function stopCameraRefresh() {
    if (STATE.cameraRefreshId) {
      clearInterval(STATE.cameraRefreshId);
      STATE.cameraRefreshId = null;
    }
  }

  function startCameraRefresh() {
    stopCameraRefresh();
    STATE.cameraRefreshId = setInterval(() => {
      const imgs = dom.items?.querySelectorAll(".staticCamImage");
      if (!imgs?.length) return;
      const t = Date.now();
      imgs.forEach(img => {
        const id = img.dataset.camId;
        if (id) img.src = `/api/cam?id=${encodeURIComponent(id)}&t=${t}`;
      });
    }, 30000);
  }

  function renderStaticCameraPanel() {
    if (!dom.items) return;

    const cameras = getAllCameraSources();
    if (!cameras.length) return;

    if (dom.eventCount) dom.eventCount.innerHTML = `<span class="liveDot"></span>Direktebilder`;

    if (dom.items.querySelector(".staticCameraPanel")) {
      if (!STATE.cameraRefreshId) startCameraRefresh();
      return;
    }

    dom.items.innerHTML = cameraPanelHtml();
    bindCameraImages();
    startCameraRefresh();
  }

  function cameraPanelHtml() {
    const figures = getAllCameraSources().map(cam => `
      <figure class="staticCamFigure">
        <img class="staticCamImage" src="${esc(cam.src)}" alt="${esc(cam.label)}"
          referrerpolicy="no-referrer" data-cam-id="${esc(cam.id)}">
        <figcaption class="staticCamCaption">${esc(cam.tunnelName)} - ${esc(cam.label)}</figcaption>
        <button type="button" class="cameraExpand" title="Forstørr kamerabildet" aria-label="Forstørr ${esc(cam.tunnelName)}">Vis bilde</button>
        <span class="cameraError">Kamerabildet er utilgjengelig</span>
      </figure>`).join("");
    return `<div class="staticCameraPanel">${figures}</div>`;
  }

  function bindCameraImages() {
    dom.items.querySelectorAll(".staticCamImage").forEach(img => {
      img.addEventListener("error", () => img.closest("figure").classList.add("cameraFailed"));
      img.addEventListener("load", () => img.closest("figure").classList.remove("cameraFailed"));
      img.closest("figure").querySelector("button").addEventListener("click", () => {
        const dialog = document.createElement("dialog");
        dialog.className = "cameraDialog";
        const title = document.createElement("div");
        title.textContent = img.closest("figure").querySelector("figcaption").textContent;
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "Lukk";
        close.addEventListener("click", () => dialog.close());
        const image = document.createElement("img");
        image.src = img.src;
        image.alt = img.alt;
        dialog.append(title, close, image);
        document.body.append(dialog);
        dialog.addEventListener("close", () => dialog.remove(), { once: true });
        dialog.showModal();
      });
    });
  }

  function fmtClosedTime(iso) {
    try {
      if (!iso) return "Ukjent";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "Ukjent";

      return d.toLocaleString("no-NO", {
        timeZone: OSLO,
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

  async function loadWeather() {
    try {
      const response = await fetch(`${CONFIG.weatherApi}?lat=${CONFIG.weatherLat}&lon=${CONFIG.weatherLon}`, {
        headers: { "User-Agent": "Byfjordtunnelen/2.0 (trafikkmeldinger.pages.dev)" }
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      const current = data.properties?.timeseries?.[0];
      const details = current?.data?.instant?.details;
      if (details) {
        const temp = details.air_temperature;
        const wind = details.wind_speed;
        const symbolCode = current.data.next_1_hours?.summary?.symbol_code
          || current.data.next_6_hours?.summary?.symbol_code;
        if (dom.weatherText) dom.weatherText.textContent = `${Math.round(temp)}°C`;
        if (dom.weatherIcon) dom.weatherIcon.textContent = getWeatherIcon(symbolCode);
        if (dom.weatherWind && wind != null) {
          dom.weatherWind.textContent = `${Math.round(wind)} m/s`;
        }
        if (dom.weather) dom.weather.style.display = "flex";
      }
    } catch {
      if (dom.weather) dom.weather.style.display = "none";
    }
  }

  function updateSourceHealth(element, sourceName, status) {
    if (!element) return;
    const maxAge = sourceName === "Vegvesen" ? 3 * 60 * 1000 : 20 * 60 * 1000;
    if (status?.state === "ok" && status.updated && measurementAge(status.updated) > maxAge) {
      status = { ...status, state: "degraded", label: "Eldre data" };
    }
    const state = ["ok", "degraded", "down"].includes(status?.state) ? status.state : "down";
    const dotClass = state === "ok" ? "healthy" : state === "degraded" ? "warning" : "unhealthy";
    const label = status?.label || (state === "ok" ? "OK" : "Utilgjengelig");
    const dot = document.createElement("span");
    dot.className = `healthDot ${dotClass}`;
    element.replaceChildren(dot, document.createTextNode(`${sourceName}: ${label}`));
    element.title = status?.detail || "";
  }

  function updateSourceStatuses(statuses) {
    updateSourceHealth(dom.vegvesenHealth, "Vegvesen", statuses?.vegvesen);
    updateSourceHealth(dom.tomtomHealth, "TomTom", statuses?.tomtom);
  }

  function updateHealth(isHealthy, message) {
    const status = {
      state: isHealthy ? "ok" : "down",
      label: isHealthy ? "OK" : "Utilgjengelig",
      detail: message || "",
    };
    updateSourceStatuses({ vegvesen: status, tomtom: status });
  }

  function isRelevantToTunnel(message, tunnelKey) {
    const tunnel = TUNNELS[tunnelKey];
    if (!tunnel) return false;
    const text = `${message.title || ""} ${message.text || ""} ${message.where || ""}`.toLowerCase();
    const keywordHit = tunnel.keywords.some(keyword => text.includes(keyword));
    if (!keywordHit) return false;

    return true;
  }

  function isMessageActiveNow(message) {
    if (message.isActive === false) return false;
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

    for (const msg of relevantMessages) {
      if (isClosureMessage(msg)) return "STENGT";
    }

    for (const msg of relevantMessages) {
      if (isPartialClosure(msg)) return "AVVIK";
      const tct = String(msg.trafficConstrictionType || "").toLowerCase();
      const rmt = String(msg.roadManagementType || "").toLowerCase();
      if (/lane.*blocked|partial|constrict|narrowing/.test(tct)) return "AVVIK";
      if (/lanemanagement|contraflow|reversible/.test(rmt)) return "AVVIK";
      const txt = `${msg.title || ""} ${msg.text || ""}`.toLowerCase();
      if (/kolonne|stans|omkjøring|lysregulering|dirigering|redusert|kø|ulykke|accident|delay|trafikkulykke|framkommelighet/.test(txt)) {
        return "AVVIK";
      }
    }

    return "ÅPEN";
  }

  function normalizeTrafficFlow(flow) {
    if (!flow || typeof flow !== "object") {
      flow = {};
    }

    const expired = measurementAge(flow.updated) > 60 * 60 * 1000;

    return {
      level: expired ? "UNKNOWN" : flow.level || "UNKNOWN",
      source: flow.source || "tomtom-flow",
      coverage: flow.coverage || "unavailable",
      segmentId: flow.segmentId || "",
      segmentLabel: flow.segmentLabel || "",
      currentRoadName: flow.currentRoadName || flow.routeDescription || "",
      currentSpeed: expired ? null : flow.currentSpeed ?? null,
      freeFlowSpeed: flow.freeFlowSpeed ?? null,
      currentTravelTime: flow.currentTravelTime ?? null,
      freeFlowTravelTime: flow.freeFlowTravelTime ?? null,
      confidence: flow.confidence ?? null,
      roadClosure: !expired && Boolean(flow.roadClosure),
      segments: Array.isArray(flow.segments) ? flow.segments.map(normalizeTrafficFlow) : [],
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

  function estimateTunnelTravelTime(lengthMeters, speedKmh) {
    const length = Number(lengthMeters);
    const speed = Number(speedKmh);
    if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(speed) || speed <= 0) return null;
    return Math.round((length / 1000 / speed) * 3600);
  }

  const FLOW_META = {
    RED: { className: "traffic-red", level: "Høy" },
    YELLOW: { className: "traffic-yellow", level: "Middels" },
    GREEN: { className: "traffic-green", level: "Lav" },
    UNKNOWN: { className: "traffic-unknown", level: "Ingen data" }
  };

  function formatDelay(seconds) {
    if (!Number.isFinite(seconds)) return "Ukjent forsinkelse";
    if (seconds < 15) return "Ingen målt forsinkelse";
    if (seconds < 60) return `+${seconds} sek`;
    return `+${Math.ceil(seconds / 60)} min`;
  }

  // Ferske målinger trenger ingen merknad; bare gamle verdier forklares på kortet.
  function staleMeasurementNote(flow) {
    const points = flow.segments.length ? flow.segments : [flow];
    const ages = points.map(point => measurementAge(point.updated)).filter(Number.isFinite);
    if (!ages.length) return "";
    const minutes = Math.floor(Math.max(...ages) / 60000);
    const old = points.some(point => point.coverage === "stale-segment-point") || minutes >= 20;
    if (!old) return "";
    return `Sist kjente måling: ${minutes} min siden${minutes >= 60 ? " · for gammel til bruk" : ""}`;
  }

  function fmtDate(iso) {
    const d = new Date(iso || "");
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("no-NO", { timeZone: OSLO, day: "numeric", month: "short", year: "numeric" });
  }

  // Fart, kjøretid og forsinkelse for én tunnel. Med to retninger gjelder den tregeste.
  function getTunnelFlowSummary(tunnel, flow) {
    const speed = flow.currentSpeed == null ? null : Number(flow.currentSpeed);
    const segments = flow.segments.slice(0, 2);
    const segmentTimes = segments
      .map(segment => estimateTunnelTravelTime(tunnel.length, segment?.currentSpeed))
      .filter(Number.isFinite);
    const segmentDelays = segments
      .map(segment => {
        const current = estimateTunnelTravelTime(tunnel.length, segment?.currentSpeed);
        const freeFlow = estimateTunnelTravelTime(tunnel.length, segment?.freeFlowSpeed);
        return Number.isFinite(current) && Number.isFinite(freeFlow) ? Math.max(0, current - freeFlow) : null;
      })
      .filter(Number.isFinite);
    const travelTime = segmentTimes.length ? Math.max(...segmentTimes) : estimateTunnelTravelTime(tunnel.length, speed);
    const freeFlowTime = estimateTunnelTravelTime(tunnel.length, flow.freeFlowSpeed ?? tunnel.speedLimit);
    const delay = segmentDelays.length
      ? Math.max(...segmentDelays)
      : Number.isFinite(travelTime) && Number.isFinite(freeFlowTime) ? Math.max(0, travelTime - freeFlowTime) : null;
    return { speed, segments, travelTime, delay, hasFlow: Number.isFinite(travelTime) };
  }

  function renderOverview() {
    const statuses = Object.values(STATE.tunnelStatuses);
    const openCount = statuses.filter(status => status === "ÅPEN").length;
    const closedCount = statuses.filter(status => status === "STENGT").length;
    const warningCount = statuses.filter(status => status === "AVVIK").length;
    const flows = Object.values(STATE.tunnelTrafficFlow).map(normalizeTrafficFlow);
    const measured = flows.filter(flow => flow.level !== "UNKNOWN");
    const closureCount = Object.entries(STATE.tunnelTrafficFlow).filter(([key, flow]) =>
      normalizeTrafficFlow(flow).roadClosure && STATE.tunnelStatuses[key] !== "STENGT"
    ).length;
    const redCount = flows.filter(flow => flow.level === "RED" && !flow.roadClosure).length;
    const yellowCount = flows.filter(flow => flow.level === "YELLOW").length;
    const activeEvents = getRelevantEventCount();

    const tone = closedCount > 0 && STATE.statusFresh ? "bad" : !STATE.statusFresh || closureCount || warningCount || redCount || yellowCount ? "warn" : "good";
    const signal = !STATE.statusFresh ? "Status må bekreftes" : closedCount > 0 ? "Stengning registrert" : closureCount ? "Kildene er uenige" : warningCount || redCount || yellowCount ? "Trafikkavvik" : "Normal drift";
    dom.overviewSignal.className = `overviewSignal ${tone}`;
    dom.overviewSignal.innerHTML = `<span class="overviewDot"></span>${signal}`;
    dom.overviewTitle.textContent = !STATE.statusFresh ? "Tunnelstatus er ikke oppdatert" : closedCount > 0
      ? `${closedCount} ${closedCount === 1 ? "tunnel er" : "tunneler er"} stengt`
      : warningCount > 0
        ? `${warningCount} ${warningCount === 1 ? "tunnel har" : "tunneler har"} avvik`
        : closureCount ? "Mulig stengning meldt av TomTom" : `Ingen stengninger registrert i ${statuses.length} tunneler`;
    dom.overviewSub.textContent = !STATE.statusFresh ? "Viser sist kjente informasjon. Kontroller Vegvesen før avreise." : closedCount ? "Bekreftet av Vegvesen. Se årsak og forventet åpning nedenfor." : closureCount ? "Stengningsvarsel fra TomTom er ikke bekreftet av Vegvesen" : warningCount
      ? "Se berørte tunneler og aktive meldinger nedenfor"
      : "Ingen registrerte stengninger eller tunnelavvik";

    dom.summaryFlow.textContent = closedCount ? "Stengt" : closureCount ? "Stengningsvarsel" : redCount > 0 ? "Kraftig kø" : yellowCount > 0 ? "Noe kø" : measured.length ? "Normal" : "Ukjent";
    dom.summaryFlow.className = closedCount ? "metricBad" : closureCount ? "metricWarn" : redCount > 0 ? "metricBad" : yellowCount > 0 ? "metricWarn" : measured.length ? "metricGood" : "";
    dom.summaryFlowDetail.textContent = closedCount ? "Bekreftet av Vegvesen" : closureCount ? "Meldt av TomTom" : redCount || yellowCount ? `${redCount + yellowCount} ${redCount + yellowCount === 1 ? "tunnel" : "tunneler"} med redusert flyt` : measured.length ? "Normal fart i målte tunneler" : "Ingen ferske trafikkmålinger";
    dom.summaryEvents.textContent = String(activeEvents);
    dom.summaryEventDetail.textContent = activeEvents === 1 ? "relevant hendelse" : "relevante hendelser";

    const delays = Object.entries(TUNNELS)
      .filter(([key]) => STATE.tunnelStatuses[key] !== "STENGT")
      .map(([key, tunnel]) => {
        const flow = normalizeTrafficFlow(STATE.tunnelTrafficFlow[key]);
        return { name: tunnel.name, level: flow.level, delay: getTunnelFlowSummary(tunnel, flow).delay };
      })
      .filter(entry => Number.isFinite(entry.delay))
      .sort((a, b) => b.delay - a.delay);
    const worst = delays[0];
    const delayed = worst && worst.delay >= 15;
    dom.summaryDelay.textContent = !worst ? "–" : delayed ? formatDelay(worst.delay) : "Ingen";
    dom.summaryDelay.className = !delayed ? "" : worst.level === "RED" ? "metricBad" : worst.level === "YELLOW" ? "metricWarn" : "";
    dom.summaryDelayDetail.textContent = !worst ? "Ingen ferske trafikkmålinger" : delayed ? worst.name : "Ingen målt forsinkelse";
  }

  function updateTunnelClosureHistory(defaultTimeIso) {
    const nextHistory = { ...STATE.lastClosedAtByTunnel };

    for (const tunnelKey of Object.keys(TUNNELS)) {
      const messages = STATE.messagesByTunnel[tunnelKey] || [];
      const closureCandidates = messages
        .filter((msg) => isClosureMessage(msg))
        .map((msg) => msg.overallStartTime || msg.time || defaultTimeIso)
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

  function renderTunnelCard(key, tunnel) {
    const flow = normalizeTrafficFlow(STATE.tunnelTrafficFlow[key]);
    const flowMeta = FLOW_META[flow.level] || FLOW_META.GREEN;
    const status = STATE.tunnelStatuses[key] || "ÅPEN";
    const closed = status === "STENGT";
    const closureConflict = flow.roadClosure && !closed;
    const statusClass = !STATE.statusFresh ? "status-unknown" : closureConflict ? "status-warning" : STATUS_CLASS[status] || "status-warning";
    const statusText = !STATE.statusFresh ? "Ubekreftet" : closureConflict ? "Stengningsvarsel" :
      closed ? "Stengt" : status === "ÅPEN" ? "Åpen" : "Avvik";

    const messages = (STATE.messagesByTunnel[key] || []).filter(isMessageActiveNow);
    const closureMessage = messages.find(isClosureMessage);
    const reason = closureMessage
      ? closureMessage.versionTime ? `Endret ${fmtClosedTime(closureMessage.versionTime)}` : closureMessage.eventDescription || closureMessage.title
      : closureConflict ? "TomTom melder stengning. Ikke bekreftet av Vegvesen."
      : messages.length ? messages[0].text || messages[0].title : "";

    const { speed, segments, travelTime, delay, hasFlow } = getTunnelFlowSummary(tunnel, flow);
    const delayText = closed ? STATE.statusFresh ? "Bekreftet stengt" : "Sist meldt stengt"
      : flow.roadClosure ? "Kontroller stengningsvarsel"
      : Number.isFinite(delay) && delay >= 15 ? formatDelay(delay) : "";

    // Rolige kort viser bare status og måling; merker og notater kommer når noe avviker.
    const flowBadge = closed ? "" : flow.roadClosure ? "TomTom-varsel" : flow.level === "UNKNOWN" ? "Ingen måling" : flow.level === "GREEN" ? "" : `${flowMeta.level} trafikk`;
    const lastClosed = closed ? "" : fmtDate(STATE.lastClosedAtByTunnel[key]);
    const sourceLink = closed && closureMessage?.situationId
      ? `<a class="closureSource" href="https://www.vegvesen.no/trafikk/trafikkmeldinger/${encodeURIComponent(closureMessage.situationId)}" target="_blank" rel="noopener noreferrer">Melding hos Vegvesen</a>` : "";
    const staleNote = closed ? "" : staleMeasurementNote(flow);

    const endTime = closureMessage?.overallEndTime ? new Date(closureMessage.overallEndTime) : null;
    const hasEndTime = endTime && Number.isFinite(endTime.getTime());
    const metricsHtml = closed
      ? `<div class="tunnelMetric"><span>Forventet åpning</span><strong>${hasEndTime ? esc(fmtTime(endTime.toISOString())) : "Ukjent"}</strong><em>${hasEndTime ? esc(endTime.toLocaleDateString("nb-NO", { timeZone: OSLO })) : "Ikke oppgitt"}</em></div><div class="tunnelMetric closureCause"><span>Årsak</span><strong>${esc(closureMessage?.eventDescription || "Stengt vei")}</strong><em>Vegvesen</em></div>`
      : segments.length === 2
      ? segments.map(segment => {
          const segmentSpeed = Number(segment?.currentSpeed);
          const segmentTime = estimateTunnelTravelTime(tunnel.length, segmentSpeed);
          const value = segment?.currentSpeed != null && Number.isFinite(segmentSpeed) ? `${Math.round(segmentSpeed)}<small> km/t</small>` : "–";
          const time = segment.roadClosure ? "Stengningsvarsel" : Number.isFinite(segmentTime) ? `ca. ${fmtDurationSeconds(segmentTime)}` : "Ingen tidsdata";
          return `<div class="tunnelMetric"><span>${esc(segment.segmentLabel || "Retning")}</span><strong>${value}</strong><em>${time}</em></div>`;
        }).join("")
      : `<div class="tunnelMetric"><span>Målt fart</span><strong>${Number.isFinite(speed) ? `${Math.round(speed)}<small> km/t</small>` : "–"}</strong></div>
         <div class="tunnelMetric"><span>Estimert kjøretid</span><strong>${Number.isFinite(travelTime) ? fmtDurationSeconds(travelTime) : "–"}</strong><em>hele tunnelen</em></div>`;

    return `
      <article class="tunnelItem ${statusClass}">
        <div class="tunnelTopline">
          <span class="statusBadge ${statusClass}"><i></i>${statusText}</span>
          <h3 class="tunnelItemName">${tunnel.name}</h3>
        </div>
        <div class="tunnelIdentity">
          <div class="tunnelIdentityRow">
            <span class="tunnelItemLength">${(tunnel.length / 1000).toFixed(1)} km</span>
            ${flowBadge ? `<span class="flowState ${flowMeta.className}"><i></i>${flowBadge}</span>` : ""}
          </div>
          ${lastClosed ? `<div class="tunnelNote">Sist stengt ${esc(lastClosed)}</div>` : ""}
          ${staleNote ? `<div class="tunnelNote">${esc(staleNote)}</div>` : ""}
          ${sourceLink ? `<div class="tunnelNote">${sourceLink}</div>` : ""}
        </div>
        <div class="tunnelMetrics ${hasFlow ? "" : "noFlow"}">${metricsHtml}</div>
        ${delayText || reason ? `<div class="tunnelBottomline">
          ${delayText ? `<span class="delay ${flowMeta.className}">${delayText}</span>` : ""}
          ${reason ? `<span class="tunnelReason">${esc(reason)}</span>` : ""}
        </div>` : ""}
      </article>`;
  }

  function renderTunnelsGrid() {
    if (!dom.tunnelsGrid) return;
    dom.tunnelsGrid.innerHTML = Object.entries(TUNNELS).map(([key, tunnel]) => renderTunnelCard(key, tunnel)).join("");
  }

  async function load() {
    if (STATE.isRefreshing) return;
    STATE.isRefreshing = true;
    startProgressCountdown();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.apiTimeoutMs);
      let response;
      try {
        response = await fetch(CONFIG.api, { cache: "no-store", signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      if (data.error) {
        console.error("API error:", data.error, data.message);
        updateHealth(false, `API-feil: ${data.error}`);
        throw new Error(data.error);
      }

      STATE.retryCount = 0;
      if (STATE.scheduledRetryId) {
        clearTimeout(STATE.scheduledRetryId);
        STATE.scheduledRetryId = null;
      }
      STATE.lastSuccessfulUpdate = new Date();
      STATE.statusFresh = !data.stale && measurementAge(data.updated) < 3 * 60 * 1000;
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
        const merged = { ...STATE.lastClosedAtByTunnel };
        for (const [key, backendDate] of Object.entries(data.tunnelHistory)) {
          if (!backendDate) continue;
          const localDate = merged[key];
          if (!localDate || new Date(backendDate) > new Date(localDate)) {
            merged[key] = backendDate;
          }
        }
        STATE.lastClosedAtByTunnel = merged;
        writeTunnelHistory(merged);
      } else {
        updateTunnelClosureHistory(data.updated);
      }

      renderTunnelsGrid();
      renderOverview();
      updateGlobalTheme();
      updateRightPanel();

      if (dom.updated) dom.updated.textContent = `Oppdatert: ${fmtTime(data.updated)}`;

      if (data.stale) {
        updateSourceStatuses(data.sourceStatus || {
          vegvesen: { state: "degraded", label: "Mellomlagret", detail: "Viser sist kjente data" },
          tomtom: { state: "degraded", label: "Mellomlagret", detail: "Viser sist kjente data" },
        });
      } else {
        updateSourceStatuses(data.sourceStatus || {
          vegvesen: { state: "ok", label: "OK" },
          tomtom: { state: "ok", label: "OK" },
        });
      }

    } catch (err) {
      STATE.statusFresh = false;
      renderTunnelsGrid();
      renderOverview();
      updateGlobalTheme();
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
          renderOverview();
          updateGlobalTheme();
          updateRightPanel();
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

  let _lastTickMinute = -1;
  function tick() {
    const now = new Date();
    if (dom.clock) {
      dom.clock.textContent = now.toLocaleTimeString("no-NO", {
        timeZone: OSLO, hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
    }
    if (dom.date) {
      dom.date.textContent = now.toLocaleDateString("no-NO", {
        timeZone: OSLO, weekday: "short", day: "numeric", month: "short"
      });
    }
    const currentMinute = Math.floor(now.getTime() / 60000);
    if (currentMinute !== _lastTickMinute) {
      _lastTickMinute = currentMinute;
      if (STATE.lastSuccessfulUpdate) {
        if (Date.now() - STATE.lastSuccessfulUpdate.getTime() > 3 * 60 * 1000) STATE.statusFresh = false;
        renderTunnelsGrid();
        renderOverview();
        updateGlobalTheme();
      }
    }
  }

  // Initialize
  tick();
  setInterval(tick, CONFIG.clockRate);
  startProgressCountdown();
  load();
  setInterval(load, CONFIG.refreshRate);
  loadWeather();
  setInterval(loadWeather, CONFIG.weatherRefreshRate);
})();
