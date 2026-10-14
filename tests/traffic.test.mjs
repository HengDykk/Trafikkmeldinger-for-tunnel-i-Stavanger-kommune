import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { isClosureMessage, isPartialClosure, measurementAge } from "../traffic-rules.js";
import { TOMTOM_FLOW_POINTS, TUNNEL_REGISTRY, classifyTomTomFlow, aggregateTomTomFlows, buildUnknownTomTomFlow, extractMessagesFromDatex, coalesceDatexMessages } from "../functions/api/combined.js";

test("partial and negated closures do not close the entire tunnel", () => {
  assert.equal(isClosureMessage({ roadManagementType: "laneBlocked" }), false);
  assert.equal(isPartialClosure({ roadManagementType: "laneBlocked" }), true);
  assert.equal(isPartialClosure({ roadManagementType: "laneClosures" }), true);
  assert.equal(isClosureMessage({ text: "Eiganestunnelen er ikke stengt" }), false);
  assert.equal(isClosureMessage({ text: "Ett felt i Eiganestunnelen er stengt" }), false);
  assert.equal(isClosureMessage({ roadManagementType: "roadClosed" }), true);
  assert.equal(isClosureMessage({ text: "Byfjordtunnelen er stengt" }), true);
});

test("Vegvesen records after the first 80 remain available", () => {
  const source = fs.readFileSync(new URL("../functions/api/combined.js", import.meta.url), "utf8");
  const extract = vm.runInNewContext(source.slice(source.indexOf("function extractMessagesFromDatex(")) + ";extractMessagesFromDatex", { TUNNEL_REGISTRY });
  const record = text => `<situationRecord><comment>${text}</comment></situationRecord>`;
  const xml = Array.from({length:80}, () => record("Stavanger vegarbeid")).join("") + record("Byfjordtunnelen stengt");
  assert.equal(extract(xml).length, 81);
  assert.equal(extract(xml)[80].text, "Byfjordtunnelen stengt");
});

test("invalid timestamps never count as a fresh measurement", () => {
  assert.equal(measurementAge(""), Infinity);
  assert.equal(measurementAge("invalid"), Infinity);
});

test("Eiganes closure survives identical comments and emergency passage exception", () => {
  const id = "NPRA_HBT_11-10-2026.150143";
  const record = (type, management, suffix) => `<ns12:situationRecord xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ns12:${type}" id="0578d59b-2662-45ca-87e4-610b2aaf251b_${suffix}">
    <comment>Nødetater må forvarsle ved behov for passering. Kontakt VTS.</comment>
    <locationDescription>E39 Eiganestunnelen i Stavanger, Rogaland</locationDescription>
    <validityStatus>definedByValidityTimeSpec</validityStatus>
    <overallStartTime>2026-10-14T22:00:00+02:00</overallStartTime>
    <overallEndTime>2026-10-15T06:00:00+02:00</overallEndTime>
    ${management ? `<ns12:roadOrCarriagewayOrLaneManagementType>${management}</ns12:roadOrCarriagewayOrLaneManagementType>` : ""}
  </ns12:situationRecord>`;
  const xml = `<ns12:situation id="${id}">${record("MaintenanceWorks", "", 1)}${record("RoadOrCarriagewayOrLaneManagement", "roadClosed", 2)}${record("RoadOrCarriagewayOrLaneManagement", "useOfSpecifiedLanesOrCarriagewaysAllowed", 2)}</ns12:situation>`;
  const records = extractMessagesFromDatex(xml);
  assert.equal(records.length, 3);
  const messages = coalesceDatexMessages(records);
  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(isClosureMessage(message), true);
  assert.equal(message.roadManagementType, "roadClosed");
  assert.equal(message.eventDescription, "Veiarbeid");
  assert.equal(message.overallEndTime, "2026-10-15T06:00:00+02:00");
  assert.ok(message.sourceUrl.endsWith(id));
  assert.ok(message.regulations.includes("useOfSpecifiedLanesOrCarriagewaysAllowed"));
});

function coordinator(initial, fetcher) {
  const values = new Map(initial ? [["state", initial]] : []);
  const context = {
    DurableObject: class { constructor(ctx) { this.ctx = ctx; } },
    TOMTOM_FLOW_POINTS, TUNNEL_REGISTRY, classifyTomTomFlow, aggregateTomTomFlows, buildUnknownTomTomFlow, extractMessagesFromDatex,
    Date, Promise, URL, AbortSignal, btoa, fetch: fetcher,
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

test("simultaneous visitors share one parsed Vegvesen snapshot", async () => {
  let calls = 0;
  const {instance} = coordinator(null, async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return {ok:true,status:200,text:async()=>'<situationRecord><comment>Byfjordtunnelen stengt</comment></situationRecord>'};
  });
  const results = await Promise.all(Array.from({length:20}, () => instance.getSituation("user", "password")));
  await instance.getSituation("user", "password");
  assert.equal(calls, 1);
  assert.equal(results[0].messages[0].text, "Byfjordtunnelen stengt");
});
