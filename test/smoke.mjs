// Runs the server logic in plain Node with fake Cloudflare storage. `npm test`
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/worker.js"), "utf8")
  .replace('import { DurableObject } from "cloudflare:workers";', "class DurableObject { constructor(ctx, env){ this.ctx = ctx; this.env = env; } }");
const tmp = join(mkdtempSync(join(tmpdir(), "cad-")), "worker.mjs");
writeFileSync(tmp, src);
globalThis.WebSocketRequestResponsePair = class {};
const { Cad } = await import(pathToFileURL(tmp));

const store = new Map();
const ctx = {
  storage: {
    async get(keys){ const m = new Map(); for (const k of keys) if (store.has(k)) m.set(k, structuredClone(store.get(k))); return m; },
    async put(o){ for (const k in o) store.set(k, structuredClone(o[k])); },
  },
  getWebSockets(){ return []; }, setWebSocketAutoResponse(){}, acceptWebSocket(){},
};
let cad = new Cad(ctx, {});
const jar = {};
async function rpc(who, op, a){
  const headers = { "content-type": "application/json", origin: "https://cad.test" };
  if (jar[who]) headers.cookie = "sid=" + jar[who];
  const res = await cad.fetch(new Request("https://cad.test/api/rpc", { method: "POST", headers, body: JSON.stringify({ op, a }) }));
  const sc = res.headers.get("set-cookie");
  if (sc){ const m = sc.match(/sid=([a-f0-9]*)/); jar[who] = m[1] || undefined; }
  return res.json();
}
let r;
r = await rpc("anon", "view"); assert.equal(r.view.setup, true);
r = await rpc("owner", "setup", { badge: "206", name: "K.Boyd", dept: "LCSO", rank: "Lieutenant", pin: "1234" }); assert.equal(r.ok, true); assert.equal(r.view.me.role, "Admin");
r = await rpc("x", "setup", { badge: "1", name: "X", dept: "LCSO", pin: "1111" }); assert.equal(r.ok, false, "setup only works once");
assert.ok(!JSON.stringify([...store.values()]).includes('"1234"'), "PIN is not stored in plain text");

r = await rpc("owner", "mkacct", { badge: "301", name: "T.Trooper", dept: "GSP", rank: "Trooper", unit: "3T-21" }); assert.equal(r.ok, true);
const tempPin = r.pin; assert.match(tempPin, /^\d{6}$/);
r = await rpc("anon", "mkacct", { badge: "999", name: "Nope", dept: "PD" }); assert.equal(r.ok, false, "only admins create logins");

for (let i = 0; i < 5; i++) { r = await rpc("t", "login", { badge: "301", pin: "0000" }); assert.equal(r.ok, false); }
r = await rpc("t", "login", { badge: "301", pin: tempPin }); assert.equal(r.ok, false, "locked after 5 wrong PINs"); assert.match(r.error, /Wait 5 minutes/);
cad.s.accounts["301"].lockUntil = 0;
r = await rpc("t", "login", { badge: "301", pin: tempPin }); assert.equal(r.ok, true); assert.equal(r.view.me.mustChange, true);
r = await rpc("t", "duty", { i: 0 }); assert.equal(r.ok, false, "must pick a PIN before duty");
r = await rpc("t", "setpin", { pin: "4321" }); assert.equal(r.ok, true); assert.equal(r.view.me.mustChange, false);
assert.equal(r.view.admin, null, "officers get no admin data");

// departments follow roles
r = await rpc("t", "addunit", { agency: "PD", unit: "2P-01" }); assert.equal(r.ok, false, "no PD role");
r = await rpc("t", "duty", { i: 0 }); assert.equal(r.ok, true); assert.equal(r.view.me.duty.unit, "3T-21");

// civilians, then records
r = await rpc("civ", "mkciv", { name: "Jordan Hale", dob: "03/14/1998" }); assert.equal(r.ok, true); const civId = r.id;
r = await rpc("civ", "mkveh", { id: civId, plate: "gsr-4821", model: "Sedan", color: "Silver" }); assert.equal(r.ok, true); assert.equal(r.view.civs[0].vehicles[0].plate, "GSR4821");
r = await rpc("other", "mkveh", { id: civId, plate: "ZZZ111", model: "Truck" }); assert.equal(r.ok, false, "cannot add to someone else's character");
r = await rpc("t", "runplate", { q: "GSR 4821" }); assert.equal(r.result.found, true); assert.equal(r.result.owner, "Jordan Hale");
r = await rpc("anon", "runplate", { q: "GSR4821" }); assert.equal(r.ok, false, "records need a logged-in unit");

// radio and scripted dispatch
r = await rpc("t", "radio", { ch: 1, text: "Dispatch, run plate GSR4821" });
let log = r.view.radio["1"]; assert.equal(log.length, 2); assert.match(log[1].text, /Jordan Hale/);
r = await rpc("t", "radio", { ch: 1, text: "show me on a traffic stop" }); assert.equal(r.view.me.duty.si, 3); assert.equal(r.view.calls.length, 1);
r = await rpc("t", "radio", { ch: 1, text: "clear" }); assert.equal(r.view.me.duty.call, null); assert.equal(r.view.history.length, 1);
r = await rpc("owner", "setcfg", { aiRadio: false }); assert.equal(r.view.cfg.aiRadio, false);
r = await rpc("t", "radio", { ch: 1, text: "10-23" }); assert.equal(r.view.radio["1"].at(-1).who, "3T-21", "dispatch stays quiet when switched off");
await rpc("owner", "setcfg", { aiRadio: true });

// calls
r = await rpc("t", "test911"); assert.equal(r.view.calls[0].status, "Pending");
r = await rpc("t", "getcall"); assert.equal(r.view.me.duty.call, r.view.calls[0].id);
r = await rpc("t", "panic"); assert.equal(r.view.me.duty.panic, true);

// admin tools
r = await rpc("owner", "trole", { badge: "301", k: "GSP" }); assert.equal(r.view.units.length, 0, "losing the role takes the unit off duty");
r = await rpc("owner", "setdiscord", { clientId: "123", guildId: "", roleMap: {} }); assert.equal(r.ok, false);
r = await rpc("owner", "setdiscord", { clientId: "123456789012345678", secret: "s3cret", guildId: "223456789012345678", roleMap: { GSP: "323456789012345678" }, webhook: "https://example.com/hook" }); assert.equal(r.ok, false, "only real Discord webhooks");
r = await rpc("owner", "setdiscord", { clientId: "123456789012345678", secret: "s3cret", guildId: "223456789012345678", roleMap: { GSP: "323456789012345678" } }); assert.equal(r.ok, true); assert.equal(r.view.cfg.discordLogin, true);
assert.ok(!JSON.stringify(r.view).includes("s3cret"), "client secret never leaves the server");
r = await rpc("owner", "toggleacct", { badge: "301" }); r = await rpc("t", "view"); assert.equal(r.view.me, null, "disabled login is signed out");

// voice bot API
async function bot(key, op, a){ const res = await cad.fetch(new Request("https://cad.test/api/bot", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ op, a }) })); return { status: res.status, body: await res.json() }; }
r = await bot("nope", "state"); assert.equal(r.status, 401, "bot API needs a key");
r = await rpc("owner", "botkey"); const botKey = r.key; assert.match(botKey, /^gsrp_/); assert.equal(r.view.cfg.botKeySet, true);
assert.ok(!JSON.stringify([...store.values()]).includes(botKey), "bot key is stored hashed");
r = await bot("wrong", "state"); assert.equal(r.status, 401);
r = await bot(botKey, "state"); assert.equal(r.body.ok, true); assert.equal(r.body.enabled, false);
r = await rpc("owner", "linkdiscord", { badge: "206", discordId: "12" }); assert.equal(r.ok, false);
r = await rpc("owner", "linkdiscord", { badge: "206", discordId: "900000000000000001" }); assert.equal(r.ok, true);
cad.s.accounts["206"].units.push({ unit: "2E-102", agency: "LCSO" });
r = await bot(botKey, "who", { discordId: "900000000000000001" }); assert.equal(r.body.onDuty, false);
r = await rpc("owner", "duty", { i: 0 }); assert.equal(r.ok, true);
r = await bot(botKey, "status", { discordId: "900000000000000001", status: "On scene" }); assert.equal(r.body.status, "On scene");
r = await bot(botKey, "createcall", { discordId: "900000000000000001", title: "Traffic stop", type: "Traffic stop" }); assert.equal(r.body.ok, true);
r = await bot(botKey, "plate", { plate: "gsr4821" }); assert.equal(r.body.owner, "Jordan Hale");
r = await bot(botKey, "log", { discordId: "900000000000000001", heard: "dispatch show me on scene", reply: "2E-102, copy, on scene." }); assert.equal(r.body.ok, true);
r = await rpc("owner", "view"); assert.match(r.view.radio["0"].at(-1).text, /copy, on scene/); assert.equal(r.view.me.duty.si, 3);
r = await bot(botKey, "status", { discordId: "111", status: "Busy" }); assert.equal(r.body.ok, false, "unlinked Discord users cannot change the CAD");
r = await bot(botKey, "clear", { discordId: "900000000000000001" }); assert.equal(r.body.ok, true);

// survives a restart
cad = new Cad(ctx, {});
r = await rpc("owner", "view"); assert.equal(r.view.me.badge, "206"); assert.equal(r.view.roster.length, 1);
r = await rpc("owner", "logout"); r = await rpc("owner", "view"); assert.equal(r.view.me, null);
// wrong-origin requests are refused
const bad = await cad.fetch(new Request("https://cad.test/api/rpc", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test" }, body: '{"op":"view"}' }));
assert.equal((await bad.json()).ok, false);
console.log("smoke test passed");
