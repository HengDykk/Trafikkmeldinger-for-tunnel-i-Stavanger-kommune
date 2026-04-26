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
    tunnelHistoryCacheKey: "byfjord:lastClosedByTunnel",
    tunnelCardFlipDelayMs: 10000,
    tunnelCardFlipDurationMs: 5000
  };

  const TUNNELS = {
    byfjord: { id: "10-8383248394a8c41b", name: "Byfjordtunnelen", keywords: ["byfjordtunnelen", "byfjord"], length: 5875, cameras: [{ id: "byfjord_nord", label: "Mot Byfjordtunnelen" }, { id: "byfjord_sor", label: "Mot Stavanger" }] },
    mastrafjord: { id: "10-31b9ef1302194439", name: "Mastrafjordtunnelen", keywords: ["mastrafjordtunnelen", "mastrafjord"], length: 4424, cameras: [] },
    eiganes: { id: "10-3e9b280fc15f0540", name: "Eiganestunnelen", keywords: ["eiganestunnelen"], length: 3174, cameras: [{ id: "eiganes", label: "Eiganestunnelen" }] },
    hundvag: { id: "10-746700d70a0dd7cd", name: "Hundvågtunnelen", keywords: ["hundvågtunnelen", "hundvagtunnelen"], length: 2100 },
    ryfast: { id: "10-e0a2a18ca95b06c6", name: "Ryfylketunnelen", keywords: ["ryfylketunnelen", "ryfast"], length: 14300, cameras: [] },
    finnoy: { id: "10-92a98043d0a97d1e", name: "Finnøytunnelen", keywords: ["finnøytunnelen", "finnoytunnelen", "finnfast"], length: 5685 },
    talgje: { id: "10-cbdb03f70d66c4c3", name: "Talgjetunnelen", keywords: ["talgjetunnelen"], length: 1467, cameras: [] },
    storhaug: { id: "10-201a7ab572b246cd", name: "Storhaugtunnelen", keywords: ["storhaugtunnelen"], length: 1100, cameras: [] }
  };

  TUNNELS.hundvag.cameras = [{ id: "hundvag_sandnes", label: "Utløp Hundvåg/Eiganes mot Sandnes" }];
  TUNNELS.finnoy.cameras = [];

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
    flippedTunnelKeys: new Set(),
    tunnelFlipIntervalId: null,
    tunnelFlipResetId: null,
    progressAnimId: null,
    scrollAnimId: null,
    scrollPauseId: null
  };

  const dom = {
    app: el("app"),
    updated: el("updated"),
    clock: el("clock"),
    date: el("date"),
    items: el("items"),
    health: el("health"),
    eventCount: el("eventCount"),
    weather: el("weather"),
    weatherText: el("weatherText"),
    weatherIcon: el("weatherIcon"),
    weatherWind: el("weatherWind"),
    progressFill: el("progressFill"),
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

  const STATUS_CLASS = { "ÅPEN": "status-open", "STENGT": "status-closed", "AVVIK": "status-warning" };

  function msgKey(m) {
    return `${m.time || ""}|${(m.title || "").trim()}|${(m.text || "").trim()}`;
  }

  function fmtMinutes(mins) {
    if (mins <= 1) return "snart";
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h} t ${m} min` : `${h} t`;
  }

  function getRushHourStatus() {
    const now = new Date();
    const day = now.getDay();
    const isWeekday = day >= 1 && day <= 5;
    const todayMin = now.getHours() * 60 + now.getMinutes();
    const MORN_START = 390; // 06:30
    const MORN_END   = 540; // 09:00
    const AFT_START  = 900; // 15:00
    const AFT_END    = 1080; // 18:00

    if (!isWeekday) {
      const nextDay = day === 6 ? "mandag" : "i morgen";
      return { label: "Helg", className: "rush-weekend", detail: `Morgenrush ${nextDay} 06:30` };
    }
    if (todayMin >= MORN_START && todayMin < MORN_END) {
      return { label: "Morgenrush", className: "rush-active", detail: `Slutter om ${fmtMinutes(MORN_END - todayMin)}` };
    }
    if (todayMin >= AFT_START && todayMin < AFT_END) {
      return { label: "Ettermiddagsrush", className: "rush-active", detail: `Slutter om ${fmtMinutes(AFT_END - todayMin)}` };
    }
    if (todayMin < MORN_START) {
      return { label: "Stille periode", className: "rush-quiet", detail: `Morgenrush starter om ${fmtMinutes(MORN_START - todayMin)}` };
    }
    if (todayMin < AFT_START) {
      return { label: "Stille periode", className: "rush-quiet", detail: `Ettermiddagsrush starter om ${fmtMinutes(AFT_START - todayMin)}` };
    }
    const tomorrowIsWeekday = ((day + 1) % 7) >= 1 && ((day + 1) % 7) <= 5;
    return { label: "Stille periode", className: "rush-quiet", detail: tomorrowIsWeekday ? "Morgenrush i morgen 06:30" : "Morgenrush mandag 06:30" };
  }

  function renderRushHourBanner() {
    const banner = document.getElementById("rushHourBanner");
    if (!banner) return;
    const s = getRushHourStatus();
    banner.className = `rushHourBanner ${s.className}`;
    banner.innerHTML = `<span class="rushLabel">${s.label}</span><span class="rushDetail">${s.detail}</span>`;
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

  function hasAnyRelevantMessages() {
    if (Object.values(STATE.messagesByTunnel).some(msgs => msgs.some(m => isMessageActiveNow(m)))) return true;
    const tunnelMsgKeys = new Set();
    Object.values(STATE.messagesByTunnel).forEach(msgs =>
      msgs.filter(m => isMessageActiveNow(m)).forEach(m => tunnelMsgKeys.add(msgKey(m)))
    );
    return STATE.allMessages.some(m => {
      if (!isMessageActiveNow(m)) return false;
      if (tunnelMsgKeys.has(msgKey(m))) return false;
      const sev = String(m.severity || "").toUpperCase();
      return sev === "HIGH" || sev === "HIGHEST" || sev === "MEDIUM";
    });
  }

  function renderIdlePanel() {
    if (!dom.items) return;
    stopAutoScroll();
    if (dom.eventCount) dom.eventCount.textContent = "Ingen tunnelhendelser";

    const rows = Object.entries(TUNNELS).map(([key, tunnel]) => {
      const flow = STATE.tunnelTrafficFlow[key] || { level: "UNKNOWN" };
      const status = STATE.tunnelStatuses[key] || "ÅPEN";
      const dotCls = STATUS_CLASS[status] || "status-open";
      const levelCls = flow.level === "RED" ? "traffic-red" : flow.level === "YELLOW" ? "traffic-yellow" : flow.level === "UNKNOWN" ? "traffic-unknown" : "traffic-green";

      const curSpd = Number(flow.currentSpeed);
      const freeSpd = Number(flow.freeFlowSpeed);
      const speedTxt = Number.isFinite(curSpd) && Number.isFinite(freeSpd)
        ? `${Math.round(curSpd)}&thinsp;/&thinsp;${Math.round(freeSpd)} km/t`
        : "—";

      const curTime = fmtDurationSeconds(flow.currentTravelTime);
      const freeTime = fmtDurationSeconds(flow.freeFlowTravelTime);
      const timeTxt = curTime || "—";
      const timeExtra = (curTime && freeTime && curTime !== freeTime)
        ? ` <span class="reisetidNormal">norm. ${freeTime}</span>` : "";

      const lastClosed = status !== "STENGT" ? STATE.lastClosedAtByTunnel[key] : null;
      const closureTxt = lastClosed ? `Sist stengt: ${fmtClosedTime(lastClosed)}` : "";

      return `
        <div class="reisetidRow ${levelCls}">
          <div class="reisetidLeft">
            <div class="reisetidName">
              <div class="tunnelGroupDot ${dotCls}"></div>
              ${esc(tunnel.name)}
            </div>
            ${closureTxt ? `<div class="reisetidMeta">${esc(closureTxt)}</div>` : ""}
          </div>
          <div class="reisetidRight">
            <div class="reisetidSpeed">${speedTxt}</div>
            <div class="reisetidTime ${levelCls}">${timeTxt}${timeExtra}</div>
          </div>
        </div>`;
    }).join("");

    dom.items.innerHTML = `<div class="reisetidTable">${rows}</div>`;
  }

  function renderSpotlightCamera(tunnelKey, cameras) {
    if (!dom.items) return;
    stopAutoScroll();
    const tunnel = TUNNELS[tunnelKey];
    if (dom.eventCount) dom.eventCount.textContent = "Live kamera";

    const imagesHtml = cameras.map(cam => `
      <figure class="spotlightFigure">
        <img class="spotlightImage" src="${esc(cam.src)}" alt="${esc(cam.label)}" referrerpolicy="no-referrer">
        <figcaption class="spotlightCaption">${esc(cam.label)}</figcaption>
      </figure>`).join("");

    dom.items.innerHTML = `
      <div class="spotlightPanel">
        <div class="spotlightHeader">
          <span class="spotlightTitle">Live kamera</span>
          <span class="spotlightTunnel">${esc(tunnel.name)}</span>
        </div>
        <div class="spotlightImages${cameras.length === 1 ? " single" : ""}">
          ${imagesHtml}
        </div>
      </div>`;
  }

  function updateRightPanel() {
    if (hasAnyRelevantMessages()) {
      renderMessagePanel();
      return;
    }
    if (STATE.flippedTunnelKeys.size > 0) {
      const key = [...STATE.flippedTunnelKeys][0];
      const cameras = getTunnelCameraSources(key);
      if (cameras.length > 0) {
        renderSpotlightCamera(key, cameras);
        return;
      }
    }
    renderIdlePanel();
  }

  function renderMessagePanel() {
    if (!dom.items) return;
    stopAutoScroll();

    // Build tunnel groups — messages that match a specific tunnel
    const tunnelMsgKeys = new Set();
    const groups = [];
    for (const [key, tunnel] of Object.entries(TUNNELS)) {
      const msgs = (STATE.messagesByTunnel[key] || []).filter(m => isMessageActiveNow(m));
      if (msgs.length > 0) {
        groups.push({ key, tunnel, msgs });
        msgs.forEach(m => tunnelMsgKeys.add(msgKey(m)));
      }
    }

    // General high-priority messages not matched to any tunnel
    const generalMsgs = STATE.allMessages.filter(m => {
      if (tunnelMsgKeys.has(msgKey(m))) return false;
      const sev = String(m.severity || "").toUpperCase();
      return sev === "HIGH" || sev === "HIGHEST" || sev === "MEDIUM";
    }).slice(0, 5);

    // Update event count
    if (dom.eventCount) {
      const n = groups.length;
      dom.eventCount.textContent = n > 0
        ? `${n} tunnel${n === 1 ? "hendelse" : "hendelser"}`
        : "Ingen tunnelhendelser";
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

    if (generalMsgs.length > 0) {
      html += `
        <div class="tunnelGroup">
          <div class="tunnelGroupHeader generalGroupHeader">Annet i Stavanger</div>
          <div class="tunnelGroupItems">
            ${generalMsgs.map(m => messageItemHtml(m)).join("")}
          </div>
        </div>`;
    }

    dom.items.innerHTML = html;
    startAutoScroll();
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

  function stopAutoScroll() {
    if (STATE.scrollAnimId) { cancelAnimationFrame(STATE.scrollAnimId); STATE.scrollAnimId = null; }
    if (STATE.scrollPauseId) { clearTimeout(STATE.scrollPauseId); STATE.scrollPauseId = null; }
  }

  function startAutoScroll() {
    stopAutoScroll();
    const items = dom.items;
    if (!items || items.scrollHeight <= items.clientHeight + 4) return;
    items.scrollTop = 0;
    const SPEED = 0.35;
    const scroll = () => {
      if (!items) return;
      if (items.scrollTop + items.clientHeight >= items.scrollHeight - 4) {
        STATE.scrollPauseId = setTimeout(() => {
          items.scrollTo({ top: 0, behavior: "smooth" });
          STATE.scrollPauseId = setTimeout(startAutoScroll, 1800);
        }, 3500);
        return;
      }
      items.scrollTop += SPEED;
      STATE.scrollAnimId = requestAnimationFrame(scroll);
    };
    STATE.scrollPauseId = setTimeout(() => {
      STATE.scrollAnimId = requestAnimationFrame(scroll);
    }, 2500);
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

  function getTrendArrow(trendType) {
    switch (String(trendType || "").toUpperCase()) {
      case "INCREASING": return `<span class="trendArrow trend-up">↑</span>`;
      case "DECREASING": return `<span class="trendArrow trend-down">↓</span>`;
      case "STABLE":     return `<span class="trendArrow trend-stable">→</span>`;
      default: return "";
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

  function getTunnelCameraSources(tunnelKey) {
    const tunnel = TUNNELS[tunnelKey];
    const cameras = Array.isArray(tunnel?.cameras) ? tunnel.cameras : [];
    const cacheBuster = Date.now();
    return cameras.map((camera) => ({
      ...camera,
      src: `/api/cam?id=${encodeURIComponent(camera.id)}&t=${cacheBuster}`
    }));
  }

  function scheduleTunnelCardRotation() {
    clearInterval(STATE.tunnelFlipIntervalId);
    clearTimeout(STATE.tunnelFlipResetId);
    STATE.tunnelFlipIntervalId = null;
    STATE.tunnelFlipResetId = null;

    const cameraTunnelKeys = Object.keys(TUNNELS).filter(
      (tunnelKey) => getTunnelCameraSources(tunnelKey).length > 0
    );

    STATE.flippedTunnelKeys = new Set();
    renderTunnelsGrid();
    updateRightPanel();

    if (!cameraTunnelKeys.length) return;

    let index = 0;
    const SHOW_MS = CONFIG.tunnelCardFlipDurationMs;
    const STEP_MS = SHOW_MS + 1200;

    const advance = () => {
      const key = cameraTunnelKeys[index % cameraTunnelKeys.length];
      index++;
      STATE.flippedTunnelKeys = new Set([key]);
      renderTunnelsGrid();
      updateRightPanel();

      STATE.tunnelFlipResetId = setTimeout(() => {
        STATE.flippedTunnelKeys = new Set();
        renderTunnelsGrid();
        updateRightPanel();
      }, SHOW_MS);
    };

    STATE.tunnelFlipResetId = setTimeout(() => {
      advance();
      STATE.tunnelFlipIntervalId = setInterval(advance, STEP_MS);
    }, CONFIG.tunnelCardFlipDelayMs);
  }


  function isClosureMessage(msg) {
    const rmt = String(msg?.roadManagementType || "").toLowerCase();
    if (/roadclosed|carriagewayclosed|carriagewayblocked|laneblocked|roadblocked/.test(rmt)) return true;
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

    for (const msg of relevantMessages) {
      if (isClosureMessage(msg)) return "STENGT";
    }

    for (const msg of relevantMessages) {
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
      return { level: "UNKNOWN", source: "unavailable", coverage: "unavailable" };
    }

    return {
      level: flow.level || "UNKNOWN",
      source: flow.source || "tomtom-flow",
      coverage: flow.coverage || "unavailable",
      currentRoadName: flow.currentRoadName || flow.routeDescription || "",
      currentSpeed: flow.currentSpeed ?? null,
      freeFlowSpeed: flow.freeFlowSpeed ?? null,
      currentTravelTime: flow.currentTravelTime ?? null,
      freeFlowTravelTime: flow.freeFlowTravelTime ?? null,
      confidence: flow.confidence ?? null,
      roadClosure: Boolean(flow.roadClosure),
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
          description: "Høy trafikkbelastning basert på TomTom sanntidsdata"
        };
      case "YELLOW":
        return {
          className: "traffic-yellow",
          level: "Middels",
          icon: "🟡",
          description: "Middels trafikkbelastning basert på TomTom sanntidsdata"
        };
      case "UNKNOWN":
        return {
          className: "traffic-unknown",
          level: "Ingen data",
          icon: "⚪",
          description: "Ingen sanntidsmåling fra TomTom for denne tunnelen"
        };
      default:
        return {
          className: "traffic-green",
          level: "Lav",
          icon: "🟢",
          description: "Lav trafikkbelastning basert på TomTom sanntidsdata"
        };
    }
  }

  function getTrafficFlowDetails(flow) {
    if (!flow || flow.level === "UNKNOWN") {
      return "Ingen sanntidsmåling tilgjengelig fra TomTom for denne tunnelen.";
    }

    const parts = [];
    if (flow.currentRoadName) {
      parts.push(`Målt på ${flow.currentRoadName}.`);
    }

    const currentSpeed = Number(flow.currentSpeed);
    const freeFlowSpeed = Number(flow.freeFlowSpeed);
    if (Number.isFinite(currentSpeed) && Number.isFinite(freeFlowSpeed)) {
      parts.push(`Hastighet ${Math.round(currentSpeed)} km/t mot normal ${Math.round(freeFlowSpeed)} km/t.`);
    }

    const currentTravelTime = fmtDurationSeconds(flow.currentTravelTime);
    const freeFlowTravelTime = fmtDurationSeconds(flow.freeFlowTravelTime);
    if (currentTravelTime && freeFlowTravelTime) {
      parts.push(`Reisetid ${currentTravelTime} mot fri flyt ${freeFlowTravelTime}.`);
    }

    return parts.join(" ");
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
      const cameras = getTunnelCameraSources(key);
      const isFlipped = cameras.length > 0 && STATE.flippedTunnelKeys.has(key);
      const frontHtml = `
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
            ${getTrendArrow(trafficFlow.trendType)}
          </span>
        </div>
        <div class="trafficFlowText">${trafficMeta.description}</div>
        <div class="trafficFlowText trafficFlowDataText">${esc(getTrafficFlowDetails(trafficFlow))}</div>
        <div class="tunnelItemReason">${esc(reason)}</div>
      `;
      const backHtml = cameras.length
        ? `
          <div class="tunnelCameraHeader">
            <span class="tunnelCameraTitle">Kamerabilder</span>
            <span class="tunnelCameraMeta">${tunnel.name}</span>
          </div>
          <div class="tunnelCameraGrid ${cameras.length === 1 ? "single" : ""}">
            ${cameras.map((camera) => `
              <figure class="tunnelCameraFigure">
                <img class="tunnelCameraImage" src="${esc(camera.src)}" alt="${esc(camera.label)}" loading="lazy" referrerpolicy="no-referrer">
                <figcaption class="tunnelCameraCaption">${esc(camera.label)}</figcaption>
              </figure>
            `).join("")}
          </div>
        `
        : `
          <div class="tunnelCameraEmpty">
            <div class="tunnelCameraTitle">Ingen kamerabilder</div>
          </div>
        `;

      return `
        <div class="tunnelItem ${statusClass} ${isFlipped ? "is-flipped" : ""} ${cameras.length ? "has-camera" : ""}">
          <div class="tunnelItemInner">
            <div class="tunnelItemFace tunnelItemFront">
              ${frontHtml}
            </div>
            <div class="tunnelItemFace tunnelItemBack">
              ${backHtml}
            </div>
          </div>
        </div>
      `;
    }).join("");
    
    dom.tunnelsGrid.innerHTML = html;
  }

  async function load() {
    if (STATE.isRefreshing) return;
    STATE.isRefreshing = true;
    startProgressCountdown();

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
      updateGlobalTheme();
      scheduleTunnelCardRotation();
      updateRightPanel();

      if (dom.updated) dom.updated.textContent = `Oppdatert: ${fmtTime(data.updated)}`;

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
          scheduleTunnelCardRotation();
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
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
    }
    if (dom.date) {
      dom.date.textContent = now.toLocaleDateString("no-NO", {
        weekday: "short", day: "numeric", month: "short"
      });
    }
    const currentMinute = now.getHours() * 60 + now.getMinutes();
    if (currentMinute !== _lastTickMinute) {
      _lastTickMinute = currentMinute;
      renderRushHourBanner();
    }
  }

  // Initialize
  tick();
  setInterval(tick, CONFIG.clockRate);
  startProgressCountdown();
  renderRushHourBanner();
  load();
  setInterval(load, CONFIG.refreshRate);
  loadWeather();
  setInterval(loadWeather, CONFIG.weatherRefreshRate);
})();
