import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { isClosureMessage, isPartialClosure, measurementAge } from "../traffic-rules.js";
import { TOMTOM_FLOW_POINTS, TUNNEL_REGISTRY, classifyTomTomFlow, aggregateTomTomFlows, buildUnknownTomTomFlow } from "../functions/api/combined.js";

test("partial and negated closures do not close the entire tunnel", () => {
  assert.equal(isClosureMessage({ roadManagementType: "laneBlocked" }), false);
  assert.equal(isPartialClosure({ roadManagementType: "laneBlocked" }), true);
  assert.equal(isClosureMessage({ text: "Eiganestunnelen er ikke stengt" }), false);
  assert.equal(isClosureMessage({ text: "Ett felt i Eiganestunnelen er stengt" }), false);
  assert.equal(isClosureMessage({ roadManagementType: "roadClosed" }), true);
  assert.equal(isClosureMessage({ text: "Byfjordtunnelen er stengt" }), true);
});

test("Vegvesen records after the first 80 remain available", () => {
  const source = fs.readFileSync(new URL("../functions/api/combined.js", import.meta.url), "utf8");
  const extract = vm.runInNewContext(source.slice(source.indexOf("function extractMessagesFromDatex(")) + ";extractMessagesFromDatex");
  const record = text => `<situationRecord><comment>${text}</comment></situationRecord>`;
  const xml = Array.from({length:80}, () => record("Oslo vegarbeid")).join("") + record("Byfjordtunnelen stengt");
  assert.equal(extract(xml).length, 81);
  assert.equal(extract(xml)[80].text, "Byfjordtunnelen stengt");
});

test("invalid timestamps never count as a fresh measurement", () => {
  assert.equal(measurementAge(""), Infinity);
  assert.equal(measurementAge("invalid"), Infinity);
});

function coordinator(initial, fetcher) {
  const values = new Map(initial ? [["state", initial]] : []);
  const context = {
    DurableObject: class { constructor(ctx) { this.ctx = ctx; } },
    TOMTOM_FLOW_POINTS, TUNNEL_REGISTRY, classifyTomTomFlow, aggregateTomTomFlows, buildUnknownTomTomFlow,
    Date, Promise, URL, AbortSignal, fetch: fetcher,
  };
  let source = fs.readFileSync(new URL("../workers/traffic-coordinator.js", import.meta.url), "utf8");
  source = source.replace(/^import .*;\r?\n/gm, "").replace("export class", "class");
  source = source.slice(0, source.indexOf("export default"));
  const Type = vm.runInNewContext(source + ";TrafficCoordinator", context);
  const instance = new Type({storage:{get: async key => structuredClone(values.get(key)), put: async (key,value) => values.set(key, structuredClone(value))}}, {});
  return {instance, values};
}

test("simultaneous visitors share 11 requests; later visits use persisted data", async () => {
  let calls = 0;
  const {instance, values} = coordinator(null, async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return {ok:true,json:async()=>({flowSegmentData:{currentSpeed:80,freeFlowSpeed:80,currentTravelTime:120,freeFlowTravelTime:120}})};
  });
  await Promise.all(Array.from({length:20}, () => instance.getTraffic("test-key")));
  await instance.getTraffic("test-key");
  assert.equal(calls, 11);
  assert.equal(values.get("state").attempts.length, 11);
});

test("failed requests count toward budget and do not retry on each visit", async () => {
  let calls = 0;
  const {instance, values} = coordinator(null, async () => { calls++; return {ok:false}; });
  await instance.getTraffic("test-key");
  await instance.getTraffic("test-key");
  assert.equal(calls, 11);
  assert.equal(values.get("state").attempts.length, 11);
});

test("rolling budget is enforced across UTC midnight", async () => {
  let calls = 0;
  const {instance} = coordinator({attempts:Array(2000).fill(Date.now()-60000),nextAttempt:0,flows:{}}, async()=>{calls++;});
  await instance.getTraffic("test-key");
  assert.equal(calls, 0);
});
