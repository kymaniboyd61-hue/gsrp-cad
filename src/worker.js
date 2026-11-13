// GSRP CAD server. One Cloudflare Worker serves the app and one Durable Object
// holds every piece of shared state: logins, units on duty, calls, radio, civilians.
import { DurableObject } from "cloudflare:workers";

const DEPTS = {
  LCSO: { name: "Sheriff's Office", leo: true, ch: 0, quick: "Traffic stop", ranks: ["Sheriff", "Undersheriff", "Captain", "Lieutenant", "Sergeant", "Corporal", "Deputy", "Probationary Deputy"] },
  GSP: { name: "State Patrol", leo: true, ch: 1, quick: "Traffic stop", ranks: ["Colonel", "Major", "Captain", "Lieutenant", "Sergeant", "Corporal", "Trooper", "Cadet"] },
  PD: { name: "Police Department", leo: true, ch: 2, quick: "Traffic stop", ranks: ["Chief", "Deputy Chief", "Captain", "Lieutenant", "Sergeant", "Corporal", "Officer", "Recruit"] },
  FD: { name: "Fire Department", leo: false, ch: 3, quick: "Structure fire", ranks: ["Fire Chief", "Battalion Chief", "Captain", "Lieutenant", "Engineer", "Firefighter", "Probationary Firefighter"] },
  EMS: { name: "EMS", leo: false, ch: 3, quick: "Medical", ranks: ["EMS Chief", "Supervisor", "Paramedic", "Advanced EMT", "EMT", "Trainee"] },
  DOT: { name: "Department of Transportation", leo: false, ch: 4, quick: "Road hazard", ranks: ["Director", "Supervisor", "Senior Operator", "Operator", "Trainee"] },
};
const DKEYS = Object.keys(DEPTS);
const CHANNELS = 6;
const STATUS = ["Available", "Busy", "En route", "On scene", "Unavailable"];
const KEYS = ["accounts", "civs", "calls", "history", "duty", "radio", "cfg", "meta", "sessions", "oauth"];
const SESSION_DAYS = 30;

class Err extends Error {}
const json = (o, headers) => new Response(JSON.stringify(o), { headers: Object.assign({ "content-type": "application/json", "cache-control": "no-store" }, headers || {}) });
const clamp = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const hhmm = () => new Date().toISOString();
const normPlate = (p) => String(p || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const rand = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map((x) => x.toString(16).padStart(2, "0")).join(""); };
const pin6 = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(100000 + (a[0] % 900000)); };
function cookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([a-f0-9]{16,64})"));
  return m ? m[1] : "";
}
async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(pin)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 10000 }, key, 256);
  return b64(bits);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return env.CAD.get(env.CAD.idFromName("main")).fetch(req);
    return env.ASSETS.fetch(req);
  },
};

export class Cad extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = null;
    this.dirty = new Set();
    this.hooks = [];
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong")); } catch (e) {}
  }

  async load() {
    if (this.s) return;
    const m = await this.ctx.storage.get(KEYS);
    const g = (k, d) => (m.get(k) === undefined ? d : m.get(k));
    this.s = {
      accounts: g("accounts", {}), civs: g("civs", []), calls: g("calls", []), history: g("history", []), duty: g("duty", {}),
      radio: g("radio", {}), cfg: g("cfg", { aiRadio: true, aiDiscord: false, webhook: "", discord: { clientId: "", secret: "", guildId: "", roleMap: {} } }),
      meta: g("meta", { nextCall: 1, nextCiv: 1, nextMsg: 1 }), sessions: g("sessions", {}), oauth: g("oauth", {}),
    };
  }
  mark(...k) { k.forEach((x) => this.dirty.add(x)); }
  async flush() {
    if (!this.dirty.size) return false;
    const o = {};
    this.dirty.forEach((k) => { o[k] = this.s[k]; });
    this.dirty.clear();
    await this.ctx.storage.put(o);
    return true;
  }

  /* ---------- sessions ---------- */
  sess(sid) {
    const x = sid && this.s.sessions[sid];
    if (!x) return null;
    if (x.exp < Date.now()) { delete this.s.sessions[sid]; this.mark("sessions"); return null; }
    return x;
  }
  newSession(data) {
    const now = Date.now(), all = this.s.sessions;
    const ids = Object.keys(all);
    if (ids.length > 400) ids.forEach((k) => { if (all[k].exp < now) delete all[k]; });
    const sid = rand(24);
    all[sid] = Object.assign({ exp: now + SESSION_DAYS * 864e5 }, data);
    this.mark("sessions");
    return sid;
  }
  acct(ss) { return ss && ss.badge ? this.s.accounts[ss.badge] || null : null; }
  ownerKey(sid, ss) { const a = this.acct(ss); return a ? "b:" + a.badge : ss && ss.discord ? "d:" + ss.discord.id : "s:" + sid; }

  /* ---------- what each person is allowed to see ---------- */
  view(sid) {
    const s = this.s, ss = this.sess(sid), a = this.acct(ss), d = s.cfg.discord || {};
    const pub = (x) => ({ badge: x.badge, name: x.name, dept: x.dept, rank: x.rank, unit: (x.units[0] || {}).unit || "" });
    const v = {
      setup: Object.keys(s.accounts).length === 0,
      cfg: { aiRadio: !!s.cfg.aiRadio, aiDiscord: !!s.cfg.aiDiscord, discordLogin: !!(d.clientId && d.secret && d.guildId), webhookSet: !!s.cfg.webhook, botKeySet: !!s.cfg.botKeyHash },
      me: null, discord: null, units: [], calls: [], history: [], radio: {},
      roster: Object.values(s.accounts).filter((x) => x.status !== "Disabled").map(pub),
      civs: sid ? s.civs.filter((c) => c.owner === this.ownerKey(sid, ss)).map((c) => ({ id: c.id, name: c.name, dob: c.dob, licence: c.licence, vehicles: c.vehicles })) : [],
      admin: null,
    };
    if (ss && ss.discord && !a) v.discord = { name: ss.discord.name, roles: ss.discord.roles, inGuild: ss.discord.inGuild };
    if (a && a.status !== "Disabled") {
      v.me = { badge: a.badge, name: a.name, dept: a.dept, rank: a.rank, role: a.role, roles: a.roles, units: a.units, mustChange: a.status === "Must change PIN", linked: !!a.discordId, duty: s.duty[a.badge] || null };
      v.units = Object.values(s.duty);
      v.calls = s.calls;
      v.history = s.history.slice(0, 25);
      v.radio = s.radio;
      if (a.role === "Admin") {
        v.admin = {
          accounts: Object.values(s.accounts).map((x) => Object.assign(pub(x), { role: x.role, roles: x.roles, status: x.status, linked: !!x.discordId })),
          discord: { clientId: d.clientId || "", guildId: d.guildId || "", roleMap: d.roleMap || {}, secretSet: !!d.secret },
        };
      }
    }
    return v;
  }
  broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      try { const at = ws.deserializeAttachment() || {}; ws.send(JSON.stringify({ t: "view", view: this.view(at.sid) })); } catch (e) {}
    }
  }

  /* ---------- radio and dispatch ---------- */
  say(ch, who, text, kind) {
    const r = this.s.radio, k = String(ch);
    (r[k] = r[k] || []).push({ id: this.s.meta.nextMsg++, who, text: clamp(text, 300), kind, at: hhmm() });
    if (r[k].length > 60) r[k].splice(0, r[k].length - 60);
    this.mark("radio", "meta");
    if (kind === "d" && this.s.cfg.aiDiscord && this.s.cfg.webhook) this.hooks.push("**DISPATCH:** " + clamp(text, 300));
  }
  dispatchSay(ch, text) { if (this.s.cfg.aiRadio || (this.s.cfg.aiDiscord && this.s.cfg.webhook)) { if (this.s.cfg.aiRadio) this.say(ch, "DISPATCH", text, "d"); else this.hooks.push("**DISPATCH:** " + text); } }
  async sendHooks() {
    const list = this.hooks.splice(0);
    if (!list.length || !this.s.cfg.webhook) return;
    try {
      await fetch(this.s.cfg.webhook, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(3000),
        body: JSON.stringify({ username: "GSRP Dispatch", content: list.join("\n").slice(0, 1800), allowed_mentions: { parse: [] } }) });
    } catch (e) {}
  }
  lookupPlate(p) {
    p = normPlate(p);
    for (const c of this.s.civs) for (const v of c.vehicles) if (v.plate === p) return { found: true, plate: v.plate, vehicle: v.color + " " + v.model, owner: c.name, registration: "Valid", flags: v.flags || "None" };
    return { found: false, plate: p };
  }
  lookupName(n) {
    n = clamp(n, 40).toLowerCase();
    const c = this.s.civs.find((x) => x.name.toLowerCase() === n);
    return c ? { found: true, name: c.name, dob: c.dob, licence: c.licence, warrants: c.warrants || "None", vehicles: c.vehicles.map((v) => v.plate) } : { found: false, name: n };
  }
  newCall(d, o) {
    if (d.call) this.clearCall(d);
    const c = { id: this.s.meta.nextCall++, title: clamp(o.title, 80), type: clamp(o.type, 40) || "Other", code: clamp(o.code, 10) || "Code 1", priority: ["Low", "Medium", "High"].includes(o.priority) ? o.priority : "Low",
      postal: clamp(o.postal, 8) || d.postal, address: clamp(o.address, 80), status: "Active", units: [d.unit], at: hhmm() };
    this.s.calls.unshift(c);
    if (this.s.calls.length > 80) this.s.calls.length = 80;
    d.call = c.id;
    this.mark("calls", "duty", "meta");
    return c;
  }
  clearCall(d) {
    const i = this.s.calls.findIndex((c) => c.id === d.call);
    d.call = null; d.si = 0; this.mark("duty");
    if (i === -1) return;
    const c = this.s.calls[i];
    c.units = c.units.filter((u) => u !== d.unit);
    if (!c.units.length) { c.status = "Closed"; this.s.calls.splice(i, 1); this.s.history.unshift(c); if (this.s.history.length > 100) this.s.history.length = 100; this.mark("history"); }
    this.mark("calls");
  }
  attach(d, c) {
    if (d.call && d.call !== c.id) this.clearCall(d);
    c.status = "Active";
    if (!c.units.includes(d.unit)) c.units.push(d.unit);
    d.call = c.id; d.si = 2; this.mark("calls", "duty");
  }
  // Free scripted dispatcher. It reads the radio message, updates the CAD, and answers.
  scripted(d, text) {
    const t = text.toLowerCase(), u = d.unit, D = DEPTS[d.agency];
    let m;
    if (D.leo && (m = t.match(/plate\s+([a-z0-9 -]{2,12})/))) {
      const p = this.lookupPlate(m[1]);
      return p.found ? `${u}, plate ${p.plate} returns to a ${p.vehicle}, owner ${p.owner}, registration ${p.registration}, flags: ${p.flags}.` : `${u}, no record on plate ${p.plate}.`;
    }
    if (D.leo && (m = text.match(/(?:run|check)\s+(?:name|subject|driver)\s+(.{3,40})/i))) {
      const n = this.lookupName(m[1].replace(/[.?!]+$/, ""));
      return n.found ? `${u}, ${n.name}, licence ${n.licence}, warrants: ${n.warrants}.` : `${u}, no record on that name.`;
    }
    const set = (i, w) => { d.si = i; this.mark("duty"); return `${u}, copy, showing you ${w}.`; };
    if (/10-?8\b|available|in service/.test(t)) return set(0, "10-8");
    if (/10-?6\b|busy/.test(t)) return set(1, "10-6");
    if (/10-?97\b|en ?route|responding/.test(t)) {
      const c = !d.call && this.s.calls.find((x) => x.status === "Pending");
      if (c) { this.attach(d, c); return `${u}, copy, attaching you to call ${c.id}, ${c.title}, postal ${c.postal}.`; }
      return set(2, "en route");
    }
    if (/10-?23\b|on scene|arrived/.test(t)) return set(3, "on scene");
    if (/10-?7\b|out of service|off duty/.test(t)) return set(4, "10-7");
    if (D.leo && /traffic stop/.test(t)) { const c = this.newCall(d, { title: "Traffic stop", type: "Traffic stop" }); d.si = 3; return `${u}, copy traffic stop at postal ${c.postal}. Call ${c.id} created.`; }
    if (/\bclear\b|code 4/.test(t) && d.call) { this.clearCall(d); return `${u}, copy, clearing your call. Showing you 10-8.`; }
    if (/any calls|get call|next call/.test(t)) {
      const c = this.s.calls.find((x) => x.status === "Pending");
      if (!c) return `${u}, no calls holding.`;
      this.attach(d, c); return `${u}, attaching you to call ${c.id}, ${c.title}, postal ${c.postal}.`;
    }
    if ((m = t.match(/postal\s+(\d{1,5})/))) { d.postal = m[1]; this.mark("duty"); return `${u}, copy, postal ${m[1]}.`; }
    return `${u}, copy.`;
  }

  /* ---------- requests ---------- */
  async fetch(req) {
    await this.load();
    const url = new URL(req.url);
    const sid = cookie(req, "sid");
    try {
      if (url.pathname === "/api/ws") {
        if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].serializeAttachment({ sid });
        pair[1].send(JSON.stringify({ t: "view", view: this.view(sid) }));
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (url.pathname === "/api/discord/start") return this.discordStart(url);
      if (url.pathname === "/api/discord/callback") return this.discordCallback(url);
      if (url.pathname === "/api/bot" && req.method === "POST") return this.bot(req);
      if (url.pathname === "/api/rpc" && req.method === "POST") {
        const origin = req.headers.get("origin");
        if (origin && origin !== url.origin) return json({ ok: false, error: "Wrong origin." });
        if (!(req.headers.get("content-type") || "").includes("application/json")) return json({ ok: false, error: "Bad request." });
        let body; try { body = await req.json(); } catch (e) { return json({ ok: false, error: "Bad request." }); }
        return this.rpc(sid, String(body.op || ""), body.a || {});
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ ok: false, error: "Server error. Try again." });
    }
  }
  async webSocketMessage() {}
  async webSocketClose(ws) { try { ws.close(); } catch (e) {} }
  async webSocketError(ws) { try { ws.close(); } catch (e) {} }

  async rpc(sid, op, a) {
    const ctx = { sid, setSid: "", out: {} };
    let res;
    try {
      const fn = this.ops[op];
      if (!fn) throw new Err("Unknown action.");
      await fn.call(this, ctx, a);
      res = Object.assign({ ok: true }, ctx.out);
    } catch (e) {
      res = { ok: false, error: e instanceof Err ? e.message : "Server error. Try again." };
    }
    const changed = await this.flush();
    const useSid = ctx.setSid || sid;
    res.view = this.view(useSid);
    if (changed) this.broadcast();
    await this.sendHooks();
    const headers = {};
    if (ctx.setSid) headers["set-cookie"] = `sid=${ctx.setSid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
    if (ctx.clearSid) headers["set-cookie"] = "sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
    return json(res, headers);
  }

  // The Discord voice bot talks to the CAD here. It proves itself with the bot key from Admin.
  async bot(req) {
    const key = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!this.s.cfg.botKeyHash || !key || (await sha256(key)) !== this.s.cfg.botKeyHash) return new Response(JSON.stringify({ ok: false, error: "Bad bot key." }), { status: 401, headers: { "content-type": "application/json" } });
    let body; try { body = await req.json(); } catch (e) { return json({ ok: false, error: "Bad request." }); }
    const a = body.a || {}, op = String(body.op || "");
    const acc = a.discordId ? Object.values(this.s.accounts).find((x) => x.discordId === String(a.discordId) && x.status !== "Disabled") : null;
    const d = acc ? this.s.duty[acc.badge] || null : null;
    const who = () => (d ? { linked: true, onDuty: true, unit: d.unit, name: d.name, rank: d.rank, department: DEPTS[d.agency].name, status: STATUS[d.si], postal: d.postal || "unknown", activeCall: d.call || null } : { linked: !!acc, onDuty: false, name: acc ? acc.name : "" });
    const need = () => { if (!d) throw new Err(acc ? "That member is not on duty on the CAD." : "That Discord user has not linked a badge on the CAD."); return d; };
    let out = {};
    try {
      if (op === "state") out = { enabled: !!this.s.cfg.aiDiscord, units: Object.values(this.s.duty).map((u) => ({ unit: u.unit, department: DEPTS[u.agency].name, status: STATUS[u.si], call: u.call })), pendingCalls: this.s.calls.filter((c) => c.status === "Pending").map((c) => ({ number: c.id, title: c.title, postal: c.postal, priority: c.priority })) };
      else if (op === "who") out = who();
      else if (op === "plate") out = this.lookupPlate(a.plate);
      else if (op === "name") out = this.lookupName(a.name);
      else if (op === "status") { const i = STATUS.indexOf(a.status); if (i === -1) throw new Err("Unknown status."); need().si = i; this.mark("duty"); out = who(); }
      else if (op === "createcall") { const c = this.newCall(need(), { title: a.title, type: a.type, postal: a.postal, priority: a.priority }); out = { callNumber: c.id, postal: c.postal }; }
      else if (op === "clear") { const x = need(); if (!x.call) throw new Err("No active call to clear."); this.clearCall(x); out = who(); }
      else if (op === "getcall") { const x = need(), c = this.s.calls.find((y) => y.status === "Pending"); if (!c) throw new Err("No calls holding."); this.attach(x, c); out = { callNumber: c.id, title: c.title, postal: c.postal }; }
      else if (op === "log") { const ch = d ? DEPTS[d.agency].ch : 0; if (clamp(a.heard, 300)) this.say(ch, (d ? d.unit : clamp(a.speaker, 30) || "Discord") + " (voice)", a.heard, "u"); if (clamp(a.reply, 300)) this.say(ch, "DISPATCH", a.reply, "d"); this.hooks.length = 0; }
      else throw new Err("Unknown action.");
    } catch (e) {
      if (await this.flush()) this.broadcast();
      return json({ ok: false, error: e instanceof Err ? e.message : "Server error." });
    }
    if (await this.flush()) this.broadcast();
    return json(Object.assign({ ok: true }, out));
  }

  member(ctx) { const a = this.acct(this.sess(ctx.sid)); if (!a || a.status === "Disabled") throw new Err("Please log in again."); return a; }
  admin(ctx) { const a = this.member(ctx); if (a.role !== "Admin") throw new Err("Admins only."); return a; }
  onDuty(ctx) { const a = this.member(ctx), d = this.s.duty[a.badge]; if (!d) throw new Err("Go on duty first."); return { a, d }; }
  async checkPin(a, pin) {
    if (a.lockUntil && a.lockUntil > Date.now()) throw new Err("Too many wrong PINs. Wait 5 minutes and try again.");
    if ((await hashPin(pin, a.salt)) !== a.hash) {
      a.fails = (a.fails || 0) + 1;
      if (a.fails >= 5) { a.fails = 0; a.lockUntil = Date.now() + 5 * 60000; }
      this.mark("accounts");
      await this.flush();
      throw new Err("That badge number and PIN do not match.");
    }
    if (a.fails || a.lockUntil) { a.fails = 0; a.lockUntil = 0; this.mark("accounts"); }
  }
  async setPin(a, pin) { a.salt = rand(16); a.hash = await hashPin(pin, a.salt); this.mark("accounts"); }
  syncRoles(a, disc) {
    a.roles = disc.roles.slice();
    const adminRole = ((this.s.cfg.discord || {}).roleMap || {}).ADMIN;
    if (disc.admin) a.role = "Admin"; else if (adminRole && a.role === "Admin" && !a.owner) a.role = "Officer";
    const d = this.s.duty[a.badge];
    if (d && !a.roles.includes(d.agency)) { if (d.call) this.clearCall(d); delete this.s.duty[a.badge]; this.mark("duty"); }
    this.mark("accounts");
  }

  get ops() {
    return OPS;
  }

  /* ---------- Discord login (reads the member's roles in your main server) ---------- */
  discordStart(url) {
    const d = this.s.cfg.discord || {};
    if (!(d.clientId && d.secret && d.guildId)) return Response.redirect(url.origin + "/?discord=off", 302);
    const state = rand(16), now = Date.now();
    Object.keys(this.s.oauth).forEach((k) => { if (this.s.oauth[k] < now) delete this.s.oauth[k]; });
    this.s.oauth[state] = now + 10 * 60000;
    this.mark("oauth");
    const q = new URLSearchParams({ client_id: d.clientId, response_type: "code", redirect_uri: url.origin + "/api/discord/callback", scope: "identify guilds.members.read", state });
    return this.flush().then(() => Response.redirect("https://discord.com/oauth2/authorize?" + q, 302));
  }
  async discordCallback(url) {
    const d = this.s.cfg.discord || {}, state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
    const fail = (why) => Response.redirect(url.origin + "/?discord=" + why, 302);
    if (!this.s.oauth[state] || this.s.oauth[state] < Date.now() || !code) return fail("expired");
    delete this.s.oauth[state]; this.mark("oauth");
    const tok = await fetch("https://discord.com/api/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: d.clientId, client_secret: d.secret, grant_type: "authorization_code", code, redirect_uri: url.origin + "/api/discord/callback" }) });
    if (!tok.ok) { await this.flush(); return fail("failed"); }
    const access = (await tok.json()).access_token, auth = { headers: { authorization: "Bearer " + access } };
    const meRes = await fetch("https://discord.com/api/users/@me", auth);
    if (!meRes.ok) { await this.flush(); return fail("failed"); }
    const user = await meRes.json();
    const memRes = await fetch(`https://discord.com/api/users/@me/guilds/${d.guildId}/member`, auth);
    const member = memRes.ok ? await memRes.json() : null;
    const ids = member ? member.roles || [] : [], map = d.roleMap || {};
    const disc = { id: String(user.id), name: clamp((member && member.nick) || user.global_name || user.username, 40), inGuild: !!member,
      roles: DKEYS.filter((k) => map[k] && ids.includes(map[k])), admin: !!(map.ADMIN && ids.includes(map.ADMIN)) };
    const a = Object.values(this.s.accounts).find((x) => x.discordId === disc.id && x.status !== "Disabled");
    if (a) this.syncRoles(a, disc);
    const sid = this.newSession({ discord: disc, badge: a ? a.badge : "" });
    if (await this.flush()) this.broadcast();
    return new Response(null, { status: 302, headers: { location: url.origin + "/", "set-cookie": `sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` } });
  }
}

function validPin(p) { if (!/^\d{4,6}$/.test(String(p))) throw new Err("PIN must be 4 to 6 digits."); return String(p); }
function validBadge(b) { b = String(b || "").trim(); if (!/^\d{1,6}$/.test(b)) throw new Err("Badge number must be 1 to 6 digits."); return b; }
function validDept(k) { if (!DEPTS[k]) throw new Err("Pick a department."); return k; }
function validRank(k, r) { return DEPTS[k].ranks.includes(r) ? r : DEPTS[k].ranks[DEPTS[k].ranks.length - 1]; }

const OPS = {
  async view() {},

  // First visit only: the very first login created becomes the owner and admin.
  async setup(ctx, a) {
    if (Object.keys(this.s.accounts).length) throw new Err("Setup is already done. Log in instead.");
    const badge = validBadge(a.badge), pin = validPin(a.pin), dept = validDept(a.dept), name = clamp(a.name, 40);
    if (!name) throw new Err("Add your name.");
    const acc = { badge, name, dept, rank: validRank(dept, a.rank), role: "Admin", owner: true, roles: DKEYS.slice(), status: "Active", units: [], discordId: "" };
    await this.setPin(acc, pin);
    this.s.accounts[badge] = acc;
    ctx.setSid = this.newSession({ badge });
  },
  async login(ctx, a) {
    const acc = this.s.accounts[String(a.badge || "").trim()];
    if (!acc) { await hashPin(String(a.pin || ""), "x"); throw new Err("That badge number and PIN do not match."); }
    if (acc.status === "Disabled") throw new Err("This login is disabled. Ask a server admin to enable it.");
    await this.checkPin(acc, a.pin);
    ctx.setSid = this.newSession({ badge: acc.badge });
  },
  // After "Log in with Discord": connect that Discord account to a badge once.
  async link(ctx, a) {
    const ss = this.sess(ctx.sid);
    if (!ss || !ss.discord) throw new Err("Log in with Discord first.");
    const acc = this.s.accounts[String(a.badge || "").trim()];
    if (!acc || acc.status === "Disabled") { await hashPin(String(a.pin || ""), "x"); throw new Err("That badge number and PIN do not match."); }
    await this.checkPin(acc, a.pin);
    if (acc.discordId && acc.discordId !== ss.discord.id) throw new Err("That badge is already linked to another Discord account. Ask an admin to unlink it.");
    Object.values(this.s.accounts).forEach((x) => { if (x.discordId === ss.discord.id) x.discordId = ""; });
    acc.discordId = ss.discord.id; ss.badge = acc.badge;
    this.syncRoles(acc, ss.discord); this.mark("sessions");
  },
  async setpin(ctx, a) {
    const acc = this.member(ctx);
    await this.setPin(acc, validPin(a.pin));
    acc.status = "Active";
  },
  async logout(ctx) {
    const acc = this.acct(this.sess(ctx.sid));
    if (acc && this.s.duty[acc.badge]) { const d = this.s.duty[acc.badge]; if (d.call) this.clearCall(d); delete this.s.duty[acc.badge]; this.mark("duty"); }
    if (ctx.sid && this.s.sessions[ctx.sid]) { delete this.s.sessions[ctx.sid]; this.mark("sessions"); }
    ctx.clearSid = true; ctx.sid = "";
  },

  async addunit(ctx, a) {
    const acc = this.member(ctx), k = validDept(a.agency), unit = clamp(a.unit, 12).toUpperCase();
    if (!acc.roles.includes(k)) throw new Err("You do not have the role for that department.");
    if (!unit) throw new Err("Type a unit number first.");
    if (acc.units.length >= 12) throw new Err("You have the most units allowed.");
    if (Object.values(this.s.accounts).some((x) => x.units.some((u) => u.unit === unit))) throw new Err("Unit " + unit + " is already taken.");
    acc.units.push({ unit, agency: k }); this.mark("accounts");
  },
  async duty(ctx, a) {
    const acc = this.member(ctx), u = acc.units[a.i | 0];
    if (acc.status === "Must change PIN") throw new Err("Pick your own PIN first.");
    if (!u) throw new Err("Pick a unit.");
    if (!acc.roles.includes(u.agency)) throw new Err("You do not have the Discord role for that department.");
    const old = this.s.duty[acc.badge];
    if (old && old.call) this.clearCall(old);
    this.s.duty[acc.badge] = { badge: acc.badge, unit: u.unit, agency: u.agency, name: acc.name, rank: acc.rank, si: 0, postal: (old && old.postal) || "", call: null, since: hhmm() };
    this.mark("duty");
  },
  async offduty(ctx) {
    const { a, d } = this.onDuty(ctx);
    if (d.call) this.clearCall(d);
    delete this.s.duty[a.badge]; this.mark("duty");
  },
  async status(ctx, a) { const { d } = this.onDuty(ctx); d.si = Math.max(0, Math.min(STATUS.length - 1, a.si | 0)); this.mark("duty"); },
  async createcall(ctx, a) {
    const { d } = this.onDuty(ctx);
    if (!clamp(a.title, 80)) throw new Err("Give the call a title first.");
    if (clamp(a.postal, 8)) d.postal = clamp(a.postal, 8);
    this.newCall(d, a); d.si = 2;
  },
  async quick(ctx, a) {
    const { d } = this.onDuty(ctx), D = DEPTS[d.agency], q = clamp(a.q, 12);
    if (D.leo) { if (!q && !a.np) throw new Err("Type a plate, or press No plate."); this.newCall(d, { title: "Traffic stop: " + (a.np ? "no plate" : normPlate(q)), type: D.quick }); d.si = 3; }
    else { if (!q) throw new Err("Type the postal first."); d.postal = q.slice(0, 8); this.newCall(d, { title: D.quick + " at postal " + d.postal, type: D.quick, postal: d.postal, priority: "High", code: "Code 3" }); d.si = 2; }
  },
  async attach(ctx, a) {
    const { d } = this.onDuty(ctx), c = this.s.calls.find((x) => x.id === (a.id | 0));
    if (!c) throw new Err("That call is closed.");
    this.attach(d, c);
  },
  async getcall(ctx) {
    const { d } = this.onDuty(ctx), c = this.s.calls.find((x) => x.status === "Pending");
    if (!c) throw new Err("No pending calls right now.");
    this.attach(d, c);
  },
  async selfclear(ctx) { const { d } = this.onDuty(ctx); if (d.call) this.clearCall(d); },
  async test911(ctx) {
    const { d } = this.onDuty(ctx), D = DEPTS[d.agency], type = D.leo ? "Disturbance" : D.quick;
    const postal = String(100 + (crypto.getRandomValues(new Uint16Array(1))[0] % 400));
    const c = { id: this.s.meta.nextCall++, title: "Test 911: " + type.toLowerCase(), type: "911 call", code: "Code 2", priority: "Medium", postal, address: "", status: "Pending", units: [], at: hhmm() };
    this.s.calls.unshift(c); this.mark("calls", "meta");
    this.dispatchSay(D.ch, `All ${D.name} units, 911 call, ${type.toLowerCase()} at postal ${postal}. Any available unit respond.`);
  },
  async panic(ctx) {
    const { d } = this.onDuty(ctx);
    d.panic = !d.panic; this.mark("duty");
    if (d.panic) for (let ch = 0; ch < CHANNELS; ch++) this.dispatchSay(ch, `All units, panic button activated by ${d.unit}, last postal ${d.postal || "unknown"}. All available units respond Code 3.`);
  },
  async runplate(ctx, a) { const { d } = this.onDuty(ctx); if (!DEPTS[d.agency].leo) throw new Err("Record search is for law enforcement units."); ctx.out.result = this.lookupPlate(a.q); },
  async runname(ctx, a) { const { d } = this.onDuty(ctx); if (!DEPTS[d.agency].leo) throw new Err("Record search is for law enforcement units."); ctx.out.result = this.lookupName(a.q); },
  async radio(ctx, a) {
    const { d } = this.onDuty(ctx), ch = Math.max(0, Math.min(CHANNELS - 1, a.ch | 0)), text = clamp(a.text, 300);
    if (!text) return;
    this.say(ch, d.unit, text, "u");
    if (this.s.cfg.aiDiscord && this.s.cfg.webhook) this.hooks.push("**" + d.unit + ":** " + text);
    if (this.s.cfg.aiRadio) this.say(ch, "DISPATCH", this.scripted(d, text), "d");
    else if (this.s.cfg.aiDiscord && this.s.cfg.webhook) this.hooks.push("**DISPATCH:** " + this.scripted(d, text));
  },

  // Civilian portal: anyone can register roleplay characters and vehicles.
  async mkciv(ctx, a) {
    if (!this.sess(ctx.sid)) { ctx.setSid = this.newSession({}); ctx.sid = ctx.setSid; }
    const owner = this.ownerKey(ctx.sid, this.sess(ctx.sid)), name = clamp(a.name, 40), dob = clamp(a.dob, 10);
    if (name.length < 3) throw new Err("Type a character name, first and last.");
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dob)) throw new Err("Write the birthday as MM/DD/YYYY.");
    if (this.lookupName(name).found) throw new Err("A character named " + name + " is already registered.");
    if (this.s.civs.filter((c) => c.owner === owner).length >= 5) throw new Err("You can register up to 5 characters.");
    if (this.s.civs.length >= 3000) throw new Err("The records are full. Ask an admin.");
    const c = { id: this.s.meta.nextCiv++, owner, name, dob, licence: "Valid", warrants: "None", vehicles: [] };
    this.s.civs.push(c); this.mark("civs", "meta"); ctx.out.id = c.id;
  },
  async mkveh(ctx, a) {
    const owner = this.ownerKey(ctx.sid, this.sess(ctx.sid)), c = this.s.civs.find((x) => x.id === (a.id | 0) && x.owner === owner);
    if (!c) throw new Err("Register a character first.");
    const plate = normPlate(a.plate), model = clamp(a.model, 40), color = clamp(a.color, 20) || "Unknown color";
    if (plate.length < 2) throw new Err("Plate must be 2 to 8 letters and numbers.");
    if (!model) throw new Err("Add the vehicle model.");
    if (this.lookupPlate(plate).found) throw new Err("Plate " + plate + " is already registered.");
    if (c.vehicles.length >= 5) throw new Err("Each character can have up to 5 vehicles.");
    c.vehicles.push({ plate, model, color, flags: "None" }); this.mark("civs");
  },

  /* ---------- admin ---------- */
  async mkacct(ctx, a) {
    this.admin(ctx);
    const badge = validBadge(a.badge), dept = validDept(a.dept), name = clamp(a.name, 40), unit = clamp(a.unit, 12).toUpperCase();
    if (this.s.accounts[badge]) throw new Err("Badge " + badge + " already has a login.");
    if (!name) throw new Err("Add the name to show on the roster.");
    if (Object.keys(this.s.accounts).length >= 500) throw new Err("Member limit reached.");
    if (unit && Object.values(this.s.accounts).some((x) => x.units.some((u) => u.unit === unit))) throw new Err("Unit " + unit + " is already taken.");
    const pin = a.pin ? validPin(a.pin) : pin6();
    const acc = { badge, name, dept, rank: validRank(dept, a.rank), role: ["Officer", "Dispatcher", "Supervisor", "Admin"].includes(a.role) ? a.role : "Officer", roles: [dept], status: "Must change PIN", units: unit ? [{ unit, agency: dept }] : [], discordId: "" };
    await this.setPin(acc, pin);
    this.s.accounts[badge] = acc;
    ctx.out.badge = badge; ctx.out.pin = pin; ctx.out.dept = dept; ctx.out.rank = acc.rank;
  },
  async resetpin(ctx, a) {
    const me = this.admin(ctx), acc = this.s.accounts[String(a.badge)];
    if (!acc) throw new Err("No such member.");
    if (acc === me) throw new Err("You cannot reset your own PIN while signed in.");
    const pin = pin6();
    await this.setPin(acc, pin); acc.status = "Must change PIN"; acc.fails = 0; acc.lockUntil = 0;
    Object.keys(this.s.sessions).forEach((k) => { if (this.s.sessions[k].badge === acc.badge) delete this.s.sessions[k]; });
    this.mark("sessions");
    ctx.out.badge = acc.badge; ctx.out.pin = pin;
  },
  async toggleacct(ctx, a) {
    const me = this.admin(ctx), acc = this.s.accounts[String(a.badge)];
    if (!acc) throw new Err("No such member.");
    if (acc === me || acc.owner) throw new Err("That login cannot be disabled.");
    acc.status = acc.status === "Disabled" ? "Active" : "Disabled";
    if (acc.status === "Disabled") {
      const d = this.s.duty[acc.badge];
      if (d) { if (d.call) this.clearCall(d); delete this.s.duty[acc.badge]; this.mark("duty"); }
      Object.keys(this.s.sessions).forEach((k) => { if (this.s.sessions[k].badge === acc.badge) delete this.s.sessions[k]; });
      this.mark("sessions");
    }
    this.mark("accounts");
  },
  async trole(ctx, a) {
    this.admin(ctx);
    const acc = this.s.accounts[String(a.badge)], k = validDept(a.k);
    if (!acc) throw new Err("No such member.");
    const i = acc.roles.indexOf(k);
    if (i === -1) acc.roles.push(k); else acc.roles.splice(i, 1);
    const d = this.s.duty[acc.badge];
    if (d && !acc.roles.includes(d.agency)) { if (d.call) this.clearCall(d); delete this.s.duty[acc.badge]; this.mark("duty"); }
    this.mark("accounts");
  },
  // Admin links a member's Discord account by ID, so the voice bot knows which unit is speaking.
  async linkdiscord(ctx, a) {
    this.admin(ctx);
    const acc = this.s.accounts[String(a.badge || "").trim()], id = clamp(a.discordId, 24);
    if (!acc) throw new Err("No member has that badge number.");
    if (!/^\d{15,22}$/.test(id)) throw new Err("A Discord user ID is a long number, 15 to 22 digits.");
    Object.values(this.s.accounts).forEach((x) => { if (x.discordId === id) x.discordId = ""; });
    acc.discordId = id; this.mark("accounts");
    ctx.out.name = acc.name;
  },
  async unlink(ctx, a) {
    this.admin(ctx);
    const acc = this.s.accounts[String(a.badge)];
    if (!acc) throw new Err("No such member.");
    acc.discordId = ""; this.mark("accounts");
  },
  async botkey(ctx) {
    this.admin(ctx);
    const key = "gsrp_" + rand(24);
    this.s.cfg.botKeyHash = await sha256(key);
    this.mark("cfg");
    ctx.out.key = key;
  },
  async setcfg(ctx, a) {
    this.admin(ctx);
    if (typeof a.aiRadio === "boolean") this.s.cfg.aiRadio = a.aiRadio;
    if (typeof a.aiDiscord === "boolean") this.s.cfg.aiDiscord = a.aiDiscord;
    this.mark("cfg");
  },
  async setdiscord(ctx, a) {
    this.admin(ctx);
    const d = this.s.cfg.discord = this.s.cfg.discord || { roleMap: {} };
    const id = (x) => { x = clamp(x, 24); if (x && !/^\d{15,22}$/.test(x)) throw new Err("Discord IDs are long numbers, 15 to 22 digits."); return x; };
    d.clientId = id(a.clientId); d.guildId = id(a.guildId);
    if (clamp(a.secret, 80)) d.secret = clamp(a.secret, 80);
    const map = {};
    DKEYS.concat(["ADMIN"]).forEach((k) => { const v = id((a.roleMap || {})[k]); if (v) map[k] = v; });
    d.roleMap = map;
    const hook = clamp(a.webhook, 200);
    if (hook) {
      if (!/^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(hook)) throw new Err("That is not a Discord webhook link.");
      this.s.cfg.webhook = hook;
    }
    if (a.clearWebhook) this.s.cfg.webhook = "";
    this.mark("cfg");
  },
};
