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
    maxRetries: 3
  };

  const TUNNELS = {
    byfjord: { name: "Byfjordtunnelen", keywords: ["byfjord"], length: 5875 },
    mastrafjord: { name: "Mastrafjordtunnelen", keywords: ["mastrafjord", "mastra"], length: 4424 },
    eiganes: { name: "Eiganestunnelen", keywords: ["eiganes"], length: 3174 },
    hundvag: { name: "Hundvågtunnelen", keywords: ["hundvåg", "hundvaag"], length: 2100 },
    ryfast: { name: "Ryfylketunnelen", keywords: ["ryfast", "ryfylke"], length: 14300 },
    sotra: { name: "Sotrasambandet", keywords: ["sotra", "sotrasambandet"], length: 0 },
    solbakk: { name: "Solbakktunnelen", keywords: ["solbakk"], length: 1350 },
    storhaug: { name: "Storhaugtunnelen", keywords: ["storhaug"], length: 1100 }
  };

  const STATE = {
    retryCount: 0,
    lastSuccessfulUpdate: null,
    isRefreshing: false,
    tunnelStatuses: {},
    allMessages: []
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
    return tunnel.keywords.some(keyword => text.includes(keyword));
  }

  function determineTunnelStatus(messages, tunnelKey) {
    const relevantMessages = messages.filter(msg => isRelevantToTunnel(msg, tunnelKey));
    if (relevantMessages.length === 0) return "ÅPEN";
    
    // Check severity first (most reliable indicator)
    for (const msg of relevantMessages) {
      const sev = String(msg.severity || "").toUpperCase();
      if (sev === "HIGHEST" || sev === "HIGH") {
        const txt = `${msg.title} ${msg.text}`.toLowerCase();
        // STENGT patterns (based on DATEX II spec)
        if (/stengt|steng[te]|closed?|closure|sperr[et]|blocked?|impassable/.test(txt)) {
          return "STENGT";
        }
      }
    }
    
    // Check for closure/severe disruption patterns
    for (const msg of relevantMessages) {
      const txt = `${msg.title} ${msg.text}`.toLowerCase();
      if (/stengt|steng[te]|closed?|closure|sperr[et]|blocked?|impassable|ikke farbar/.test(txt)) {
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

  function renderTunnelsGrid() {
    if (!dom.tunnelsGrid) return;
    
    const html = Object.entries(TUNNELS).map(([key, tunnel]) => {
      const status = STATE.tunnelStatuses[key] || "ÅPEN";
      const statusClass = 
        status === "ÅPEN" ? "status-open" :
        status === "STENGT" ? "status-closed" : "status-warning";
      
      const statusText = 
        status === "ÅPEN" ? "Åpen" :
        status === "STENGT" ? "Stengt" : "Avvik";
      
      const tunnelMessages = STATE.allMessages.filter(msg => isRelevantToTunnel(msg, key));
      const reason = tunnelMessages.length > 0 
        ? (tunnelMessages[0].text || tunnelMessages[0].title)
        : "Ingen merknader";
      
      const lengthText = tunnel.length > 0 ? `${(tunnel.length/1000).toFixed(1)} km` : "";
      const travelTime = tunnel.length > 0 ? `~${Math.ceil(tunnel.length/1000)} min` : "";
      
      return `
        <div class="tunnelItem ${statusClass}">
          <div class="tunnelItemHeader">
            <div class="tunnelItemStatus">
              <div class="statusDot ${statusClass}"></div>
              <span class="statusLabel">${statusText}</span>
            </div>
            ${travelTime ? `<span class="tunnelTime">${travelTime}</span>` : ''}
          </div>
          <h3 class="tunnelItemName">${tunnel.name}</h3>
          ${lengthText ? `<div class="tunnelItemLength">${lengthText}</div>` : ''}
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
      const timeoutId = setTimeout(() => controller.abort(), 10000);
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
      STATE.lastSuccessfulUpdate = new Date();
      STATE.allMessages = data.stavanger?.messages || [];

      Object.keys(TUNNELS).forEach(tunnelKey => {
        STATE.tunnelStatuses[tunnelKey] = determineTunnelStatus(STATE.allMessages, tunnelKey);
      });

      // DEBUG: Log tunnel statuses to console
      console.log("=== TUNNEL STATUSER ===");
      Object.entries(STATE.tunnelStatuses).forEach(([key, status]) => {
        const tunnel = TUNNELS[key];
        const messages = STATE.allMessages.filter(msg => isRelevantToTunnel(msg, key));
        console.log(`${tunnel.name}: ${status}`);
        if (messages.length > 0) {
          messages.forEach(msg => {
            console.log(`  - ${msg.title}: ${msg.text}`);
            console.log(`    Severity: ${msg.severity}`);
          });
        }
      });

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

      updateHealth(true, "System status: OK");

    } catch (err) {
      STATE.retryCount++;
      console.error("Data fetch error:", err);

      if (STATE.retryCount < CONFIG.maxRetries) {
        updateHealth(false, `Kobler til på nytt... (${STATE.retryCount}/${CONFIG.maxRetries})`);
        setTimeout(() => load(), CONFIG.retryDelay);
      } else {
        updateHealth(false, "Ingen forbindelse til API");
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
