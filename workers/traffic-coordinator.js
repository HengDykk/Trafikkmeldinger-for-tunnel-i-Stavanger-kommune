import { DurableObject } from "cloudflare:workers";
import { TOMTOM_FLOW_POINTS, TUNNEL_REGISTRY, classifyTomTomFlow, buildUnknownTomTomFlow, aggregateTomTomFlows, extractMessagesFromDatex } from "../functions/api/combined.js";

const INTERVAL = 15 * 60 * 1000;
const WINDOW = 24 * 60 * 60 * 1000;
const BUDGET = 2000;
const MAX_AGE = 60 * 60 * 1000;

export class TrafficCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = null;
    this.pendingSituation = null;
  }

  async getSituation(user, password) {
    if (!this.pendingSituation) {
      this.pendingSituation = this.refreshSituation(user, password).finally(() => { this.pendingSituation = null; });
    }
    return this.pendingSituation;
  }

  async refreshSituation(user, password) {
    const saved = await this.ctx.storage.get("situation-v3");
    if (saved && Date.now() - saved.fetchedAt < 45000) return saved.result;
    let result;
    try {
      const headers = { "User-Agent": "Byfjordtunnelen/1.0 (Cloudflare Pages)" };
      if (user && password) headers.Authorization = "Basic " + btoa(`${user}:${password}`);
      const response = await fetch("https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi/GetSituation/pullsnapshotdata", {
        headers, signal: AbortSignal.timeout(8000),
      });
      const xml = response.ok ? await response.text() : "";
      const messages = response.ok ? extractMessagesFromDatex(xml) : [];
      result = { ok: response.ok, status: response.status, messages, updated: new Date().toISOString() };
    } catch {
      result = { ok: false, status: 503, messages: [], updated: "" };
    }
    await this.ctx.storage.put("situation-v3", { fetchedAt: Date.now(), result });
    return result;
  }

  async getTraffic(apiKey) {
    if (!this.pending) {
      this.pending = this.refresh(apiKey).finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  async refresh(apiKey) {
    const now = Date.now();
    const state = await this.ctx.storage.get("state") || { attempts: [], nextAttempt: 0, flows: {} };
    state.attempts = state.attempts.filter(at => now - at < WINDOW);
    const points = Object.entries(TOMTOM_FLOW_POINTS).flatMap(([tunnel, configured]) =>
      (Array.isArray(configured) ? configured : [configured]).map(point => ({ tunnel, point }))
    );
    if (now < state.nextAttempt || state.attempts.length + points.length > BUDGET) {
      return this.snapshot(state, now);
    }

    // Reserve every attempted request before network I/O, including failures.
    state.attempts.push(...points.map(() => now));
    state.nextAttempt = now + INTERVAL;
    await this.ctx.storage.put("state", state);

    const fetched = await Promise.all(points.map(async ({ tunnel, point }) => {
      const id = point.id || tunnel;
      const previous = state.flows[`${tunnel}:${id}`];
      try {
        const url = new URL("https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/14/json");
        url.searchParams.set("key", apiKey);
        url.searchParams.set("point", `${point.lat},${point.lon}`);
        url.searchParams.set("unit", "KMPH");
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error("TomTom request rejected");
        const payload = await response.json();
        const segment = payload.flowSegmentData;
        if (!segment || segment.currentSpeed == null || !Number.isFinite(Number(segment.currentSpeed))) throw new Error("Missing segment");
        return [`${tunnel}:${id}`, {
          source: "tomtom-flow", coverage: "segment-point", segmentId: id,
          segmentLabel: point.label || TUNNEL_REGISTRY[tunnel].name,
          level: classifyTomTomFlow(segment), currentSpeed: segment.currentSpeed,
          freeFlowSpeed: segment.freeFlowSpeed, currentTravelTime: segment.currentTravelTime,
          freeFlowTravelTime: segment.freeFlowTravelTime, confidence: segment.confidence,
          roadClosure: Boolean(segment.roadClosure), updated: new Date().toISOString(),
        }];
      } catch {
        return [`${tunnel}:${id}`, previous ? { ...previous, coverage: "stale-segment-point" } : {
          ...buildUnknownTomTomFlow("api-error"), segmentId: id,
          segmentLabel: point.label || TUNNEL_REGISTRY[tunnel].name,
        }];
      }
    }));
    state.flows = Object.fromEntries(fetched);
    await this.ctx.storage.put("state", state);
    return this.snapshot(state, Date.now());
  }

  snapshot(state, now) {
    return Object.fromEntries(Object.entries(TOMTOM_FLOW_POINTS).map(([tunnel, configured]) => {
      const flows = (Array.isArray(configured) ? configured : [configured]).map(point => {
        const id = point.id || tunnel;
        const flow = state.flows[`${tunnel}:${id}`];
        if (!flow || now - Date.parse(flow.updated || "") > MAX_AGE || !flow.updated) {
          return { ...buildUnknownTomTomFlow("unavailable"), segmentId: id, segmentLabel: point.label || TUNNEL_REGISTRY[tunnel].name };
        }
        return now - Date.parse(flow.updated) >= INTERVAL
          ? { ...flow, coverage: "stale-segment-point" } : flow;
      });
      return [tunnel, flows.length > 1 ? aggregateTomTomFlows(flows) : flows[0]];
    }));
  }
}

export default {
  fetch() { return new Response("Internal traffic coordinator", { status: 404 }); },
};
