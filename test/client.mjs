// Drives public/app.js against the real server logic with a tiny fake page. `node test/client.mjs`
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/worker.js"), "utf8").replace('import { DurableObject } from "cloudflare:workers";', "class DurableObject { constructor(ctx, env){ this.ctx = ctx; this.env = env; } }");
const tmp = join(mkdtempSync(join(tmpdir(), "cad-")), "worker.mjs"); writeFileSync(tmp, src);
globalThis.WebSocketRequestResponsePair = class {};
const { Cad } = await import(pathToFileURL(tmp));
const store = new Map();
const cad = new Cad({ storage: { async get(ks){ const m = new Map(); for (const k of ks) if (store.has(k)) m.set(k, structuredClone(store.get(k))); return m; }, async put(o){ for (const k in o) store.set(k, structuredClone(o[k])); } }, getWebSockets(){ return []; }, setWebSocketAutoResponse(){} }, {});

let sid = "";
const els = {}; const el = (id) => (els[id] = els[id] || { id, innerHTML: "", textContent: "", hidden: true, value: "", classList: { add(){}, remove(){}, toggle(){} }, offsetWidth: 0, focus(){}, scrollTop: 0, scrollHeight: 0, firstChild: { style: {} }, lastChild: { style: {} }, setAttribute(){}, scrollIntoView(){} });
const handlers = {};
const sandbox = {
  console, setTimeout, clearTimeout, setInterval: (f, ms) => { const t = setInterval(f, ms); t.unref(); return t; }, clearInterval, URLSearchParams, Promise, JSON, Math, Date, Error, String, Object, Array, RegExp, isNaN,
  localStorage: { getItem(){ return null; }, setItem(){} },
  location: { protocol: "https:", host: "cad.test", origin: "https://cad.test", search: "", reload(){} }, history: { replaceState(){} }, navigator: {},
  WebSocket: class { constructor(){ this.readyState = 0; } close(){} send(){} },
  document: { querySelector: (s) => (["#app", "#toast", "#radioMount"].includes(s) ? el(s) : null), querySelectorAll: () => [], getElementById: () => null, activeElement: null, addEventListener: (n, f) => { handlers[n] = f; } },
  fetch: async (path, o) => {
    const headers = Object.assign({ origin: "https://cad.test" }, o.headers); if (sid) headers.cookie = "sid=" + sid;
    const res = await cad.fetch(new Request("https://cad.test" + path, { method: "POST", headers, body: o.body }));
    const sc = res.headers.get("set-cookie"); if (sc) sid = sc.match(/sid=([a-f0-9]*)/)[1];
    return res;
  },
};
sandbox.window = sandbox; sandbox.addEventListener = () => {}; sandbox.scrollTo = () => {};
process.on("unhandledRejection", (e) => { console.error("FAILED", e); process.exit(1); });
vm.runInNewContext(readFileSync(join(here, "../public/app.js"), "utf8"), sandbox);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const type = (f, value) => handlers.input({ target: { dataset: { f }, value, inputMode: "", id: "" } });
const click = (act, data) => handlers.click({ target: { closest: () => ({ dataset: Object.assign({ act }, data || {}), disabled: false }) } });
const app = () => el("#app").innerHTML, radio = () => el("#radioMount").innerHTML;

await wait(50); assert.match(app(), /Create the owner login/);
type("s-badge", "206"); type("s-name", "K.Boyd"); type("s-pin", "1234"); click("setup");
await wait(3800); assert.match(app(), /Choose your CAD/); assert.match(app(), /ROLE FOUND/);
type("u-unit-LCSO", "2e-102"); click("addunit", { k: "LCSO" }); await wait(50); assert.match(app(), /2E-102/);
click("duty", { i: "0" }); await wait(50); assert.match(app(), /Active units/); assert.match(app(), /SHERIFF&#39;S OFFICE/);
click("status"); await wait(50); assert.match(app(), /Busy/);
type("c-title", "Loud party"); click("createcall"); await wait(50); assert.match(app(), /Active call #1: Loud party/);
click("selfclear"); await wait(50); assert.match(app(), /No active call/);
click("run"); assert.match(app(), /Search records/); type("runq", "NOPE1"); click("runsearch"); await wait(50); assert.match(app(), /No record found/);
click("quick"); type("quickq", "abc123"); click("mkquick"); await wait(50); assert.match(app(), /Traffic stop: ABC123/);
click("radio"); assert.match(radio(), /HOLD TO TALK/); click("join"); assert.match(radio(), /Leave/);
type("radiomsg", "Dispatch, show me 10-8"); click("rsend"); await wait(50); assert.match(radio(), /DISPATCH/); assert.match(radio(), /showing you 10-8/);
// pop-out handheld radio
const hh = { innerHTML: "" }, pipHandlers = {};
sandbox.open = () => ({ closed: false, focus(){}, addEventListener(){}, document: { title: "", head: { innerHTML: "" }, body: { innerHTML: "" }, getElementById: (id) => (id === "hh" ? hh : null), addEventListener: (n, f) => { pipHandlers[n] = f; } } });
click("popout"); await wait(20); assert.match(hh.innerHTML, /Push to talk/); assert.match(hh.innerHTML, /Global RTO/); assert.match(hh.innerHTML, /2E-102/);
const pclick = (act, data) => pipHandlers.click({ target: { closest: () => ({ dataset: Object.assign({ act }, data || {}) }) } });
pclick("ch-next"); assert.match(hh.innerHTML, /State Patrol/); pclick("ch-prev"); assert.match(hh.innerHTML, /Global RTO/);
pclick("hstat", { si: "3" }); await wait(50); assert.match(hh.innerHTML, /On scene/); assert.match(app(), /On scene/);
pclick("hpower"); assert.match(hh.innerHTML, /Radio off/); pclick("hpower"); assert.match(hh.innerHTML, /DISPATCH:/); pclick("hstat-up"); await wait(50); assert.match(hh.innerHTML, /En route/);
click("panic"); await wait(50); assert.match(app(), /PANIC: 2E-102/); click("panic"); await wait(50);
click("test911"); await wait(50); assert.match(app(), /Test 911/); click("getcall"); await wait(50); assert.match(app(), /Active call #3/);
click("admin"); assert.match(app(), /Create a login/);
type("a-badge", "301"); type("a-name", "T.Trooper"); type("a-unit", "3T-21"); handlers.change({ target: { id: "f-a-dept", value: "GSP" } }); click("mkacct"); await wait(50);
assert.match(app(), /temporary PIN/); assert.match(app(), /State Patrol roster as Cadet/);
click("trole", { b: "301", k: "PD" }); await wait(50);
click("atab", { t: "ai" }); assert.match(app(), /CAD radio: On/); click("ai-radio"); await wait(50); assert.match(app(), /CAD radio: Off/);
click("atab", { t: "discord" }); assert.match(app(), /api\/discord\/callback/);
click("roster"); assert.match(app(), /Department rosters/); click("rdept", { k: "GSP" }); assert.match(app(), /T\.Trooper/); assert.match(app(), /NEW/);
click("civ"); type("v-name", "Jordan Hale"); type("v-dob", "03/14/1998"); click("mkciv"); await wait(50); assert.match(app(), /DRIVER LICENCE/);
type("v-plate", "gsr4821"); type("v-model", "Sedan"); click("mkveh"); await wait(50); assert.match(app(), /GSR4821/);
click("back"); click("backcad"); await wait(20); assert.match(app(), /Active units/);
click("offduty"); await wait(50); assert.match(app(), /Choose your CAD/);
click("logout"); await wait(50); assert.match(app(), /CAD sign in/);
type("badge", "206"); type("pin", "9999"); click("login"); await wait(50); assert.match(app(), /do not match/);
console.log("client test passed");
process.exit(0);
