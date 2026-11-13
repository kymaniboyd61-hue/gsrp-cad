/* GSRP CAD app. Talks to the server at /api and redraws when the server pushes changes. */
(function(){
'use strict';
var $ = function(s){ return document.querySelector(s); };
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function hm(iso){ var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }

var STATUSES = [
  {label:'Available', color:'#6EE7A0'}, {label:'Busy', color:'#FBBF24'},
  {label:'En route', color:'#7CB8FF'}, {label:'On scene', color:'#D3A6FF'},
  {label:'Unavailable', color:'#B4B8BD'}
];
var CODES = [['10-1','Poor radio signal'],['10-2','Signal good'],['10-4','Acknowledged'],['10-6','Busy'],['10-7','Out of service'],['10-8','Available'],['10-9','Repeat last'],['10-20','Location'],['10-23','On scene'],['10-97','En route']];
var CHANNELS = [
  {name:'Global RTO', freq:'155.1 MHz'}, {name:'State Patrol', freq:'155.4 MHz'}, {name:'Police Department', freq:'155.6 MHz'},
  {name:'Fire / EMS', freq:'155.2 MHz'}, {name:'Georgia DOT', freq:'154.2 MHz'}, {name:'TAC 1', freq:'155.3 MHz'}
];
var DEPTS = {
  LCSO:{name:"Sheriff's Office", color:'#E0B15A', leo:true, ch:0, quick:['Traffic Stop','Traffic stop'], types:['Traffic stop','Collision','Pursuit','Disturbance','Other'],
    ranks:['Sheriff','Undersheriff','Captain','Lieutenant','Sergeant','Corporal','Deputy','Probationary Deputy']},
  GSP:{name:'State Patrol', color:'#7CB8FF', leo:true, ch:1, quick:['Traffic Stop','Traffic stop'], types:['Traffic stop','Collision','Pursuit','Speed enforcement','Other'],
    ranks:['Colonel','Major','Captain','Lieutenant','Sergeant','Corporal','Trooper','Cadet']},
  PD:{name:'Police Department', color:'#9DB4FF', leo:true, ch:2, quick:['Traffic Stop','Traffic stop'], types:['Traffic stop','Disturbance','Burglary','Pursuit','Other'],
    ranks:['Chief','Deputy Chief','Captain','Lieutenant','Sergeant','Corporal','Officer','Recruit']},
  FD:{name:'Fire Department', color:'#FF9A7A', leo:false, ch:3, quick:['Fire Call','Structure fire'], types:['Structure fire','Vehicle fire','Rescue','Alarm','Other'],
    ranks:['Fire Chief','Battalion Chief','Captain','Lieutenant','Engineer','Firefighter','Probationary Firefighter']},
  EMS:{name:'EMS', color:'#F2A7C3', leo:false, ch:3, quick:['Medical Call','Medical'], types:['Medical','Collision with injuries','Transport','Standby','Other'],
    ranks:['EMS Chief','Supervisor','Paramedic','Advanced EMT','EMT','Trainee']},
  DOT:{name:'Department of Transportation', color:'#FBBF24', leo:false, ch:4, quick:['Road Hazard','Road hazard'], types:['Road hazard','Tow request','Traffic control','Disabled vehicle','Other'],
    ranks:['Director','Supervisor','Senior Operator','Operator','Trainee']}
};
var DKEYS = Object.keys(DEPTS);
var ICON = {
  home:'<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"></path>',
  map:'<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"></path><circle cx="12" cy="10" r="2.5"></circle>',
  run:'<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M7 9l3 3-3 3M13 15h4"></path>',
  disp:'<path d="M4 14v-2a8 8 0 0 1 16 0v2"></path><path d="M4 14h3v5H5a1 1 0 0 1-1-1zM20 14h-3v5h2a1 1 0 0 0 1-1z"></path>',
  stop:'<rect x="8" y="2" width="8" height="20" rx="3"></rect><circle cx="12" cy="7" r="1.5"></circle><circle cx="12" cy="12" r="1.5"></circle><circle cx="12" cy="17" r="1.5"></circle>',
  panic:'<path d="M12 3l10 18H2zM12 10v5M12 18h.01"></path>',
  radio:'<rect x="7" y="8" width="10" height="13" rx="2"></rect><path d="M10 8V3M10 12h4"></path>',
  roster:'<circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 5.5a3 3 0 0 1 0 5.5M18 14.5a5.5 5.5 0 0 1 3.5 5.5"></path>'
};
function icon(n){ return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICON[n] + '</svg>'; }

/* V is what the server says. S is only what this screen is doing. */
var V = {setup:false, cfg:{}, me:null, discord:null, units:[], calls:[], history:[], radio:{}, roster:[], civs:[], admin:null};
var S = {
  screen:'boot', back:'login', f:{}, kfield:'badge', err:'', errAt:'', pct:0, callTab:'active', flashCall:0,
  run:{open:false, tab:'Vehicle', result:null}, quick:{open:false},
  radio:{open:false, sel:0, joined:-1, tx:false, pop:false, seen:0, live:''},
  adminTab:'members', adminNote:'', rosterDept:'LCSO', newBadge:'', voice:false, online:true
};
try{ S.voice = localStorage.getItem('gsrp-voice') === '1'; }catch(e){}
var MEMBER = {newpin:1, loading:1, units:1, cad:1, admin:1};
var LIVE = {units:1, cad:1, admin:1, roster:1};

/* ---------- server ---------- */
function rpc(op, a){
  return fetch('/api/rpc', {method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'}, body:JSON.stringify({op:op, a:a || {}})})
    .then(function(r){ return r.json(); }, function(){ throw new Error('No connection to the CAD server. Check your internet and try again.'); })
    .then(function(j){ if (j.view) setView(j.view); if (!j.ok) throw new Error(j.error || 'Something went wrong. Try again.'); return j; });
}
function act(op, a, o){
  o = o || {};
  return rpc(op, a).then(function(j){ S.err = ''; S.errAt = ''; if (o.then) o.then(j); render(); return j; })
    .catch(function(e){ if (o.errAt !== undefined){ S.err = e.message; S.errAt = o.errAt; render(); } else toast(e.message); });
}
function setView(v){
  var r = S.radio;
  if (v.me && r.joined !== -1){
    var list = v.radio[String(r.joined)] || [], fresh = list.filter(function(m){ return m.id > r.seen; });
    if (r.seen && fresh.length){
      var mine = v.me.duty ? v.me.duty.unit : '';
      fresh.forEach(function(m){ if (m.who !== mine){ beep(m.kind === 'd' ? 1000 : 800, 70); if (S.voice) speak((m.kind === 'd' ? '' : m.who + '. ') + m.text); } });
    }
  }
  if (v.me && V.me){
    var known = {}; V.calls.forEach(function(c){ known[c.id] = 1; });
    v.calls.forEach(function(c){ if (!known[c.id]){ S.flashCall = c.id; if (c.status === 'Pending') beep(880, 160); } });
    var wasPanic = V.units.some(function(u){ return u.panic; }), isPanic = v.units.some(function(u){ return u.panic; });
    if (isPanic && !wasPanic){ beep(900, 250); setTimeout(function(){ beep(600, 350); }, 280); }
  }
  V = v;
  if (!V.me && MEMBER[S.screen]){ S.screen = V.discord ? 'link' : 'login'; closeSocket(); }
  if (V.me && S.screen === 'cad' && !V.me.duty) S.screen = 'units';
}
var ws = null, wsTimer = 0, wsWait = 1000;
function closeSocket(){ clearTimeout(wsTimer); if (ws){ try{ ws.onclose = null; ws.close(); }catch(e){} ws = null; } }
function connect(){
  closeSocket();
  if (!V.me) return;
  try{ ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/ws'); }catch(e){ return; }
  ws.onopen = function(){ wsWait = 1000; if (!S.online){ S.online = true; render(); } };
  ws.onmessage = function(ev){
    if (ev.data === 'pong') return;
    try{ var m = JSON.parse(ev.data); if (m.t === 'view'){ setView(m.view); if (LIVE[S.screen]) render(); } }catch(e){}
  };
  ws.onclose = function(){ ws = null; if (S.online){ S.online = false; if (LIVE[S.screen]) render(); } wsTimer = setTimeout(connect, wsWait); wsWait = Math.min(wsWait * 2, 30000); };
}
setInterval(function(){ try{ if (ws && ws.readyState === 1) ws.send('ping'); }catch(e){} }, 45000);

/* ---------- small helpers ---------- */
var toastTimer;
function toast(msg){ var t = $('#toast'); t.hidden = true; void t.offsetWidth; t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function(){ t.hidden = true; }, 3200); }
var actx;
function beep(freq, ms){
  try{
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    var o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = freq; g.gain.value = 0.06; o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime + ms / 1000);
  }catch(e){}
}
function speak(text){ try{ if (!window.speechSynthesis) return; var u = new SpeechSynthesisUtterance(text); u.rate = 1.1; window.speechSynthesis.speak(u); }catch(e){} }
function fv(k){ return S.f[k] == null ? '' : S.f[k]; }
function field(key, label, attrs){ return '<div class="field"><label for="f-' + key + '">' + label + '</label><input id="f-' + key + '" data-f="' + key + '" value="' + esc(fv(key)) + '" ' + (attrs || 'type="text"') + ' autocomplete="off"></div>'; }
function select(key, label, opts){
  var cur = fv(key) || (opts[0].v || opts[0]);
  return '<div class="field"><label for="f-' + key + '">' + label + '</label><select id="f-' + key + '" data-f="' + key + '">' + opts.map(function(o){ var v = o.v || o, t = o.t || o; return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></div>';
}
var deptOpts = DKEYS.map(function(k){ return {v:k, t:DEPTS[k].name}; });
function dept(k){ return DEPTS[k] || DEPTS.LCSO; }
function deptTag(k){ return '<span class="tag" style="color:' + dept(k).color + '">' + esc(k) + '</span>'; }
function pips(dk, rank){
  var r = dept(dk).ranks, i = r.indexOf(rank); if (i < 0) i = r.length - 1;
  var n = Math.max(1, Math.round((r.length - i) / r.length * 5)), h = '';
  for (var j = 1; j <= 5; j++) h += '<i class="' + (j <= n ? 'f' : '') + '" style="height:' + (4 + j * 2) + 'px"></i>';
  return '<span class="pips" role="img" aria-label="Rank level ' + n + ' of 5">' + h + '</span>';
}
function hasRole(k){ return V.me && V.me.roles.indexOf(k) !== -1; }
function findCall(id){ for (var i = 0; i < V.calls.length; i++) if (V.calls[i].id === id) return V.calls[i]; return null; }

/* ---------- screens ---------- */
function keypad(title){
  var keys = ['1','2','3','4','5','6','7','8','9','Del','0','Next'];
  return '<div class="keypad"><div class="muted">Typing into: <b style="color:var(--green-text)">' + title + '</b></div><div class="keys">' +
    keys.map(function(k){ return '<button type="button" class="' + (k.length > 1 ? 'sm' : '') + '" data-act="key" data-k="' + k + '">' + k + '</button>'; }).join('') + '</div></div>';
}
function badgePin(){
  return '<div class="field"><label for="f-badge">Badge number</label><input id="f-badge" data-f="badge" data-kf="badge" inputmode="numeric" autocomplete="off" class="' + (S.kfield === 'badge' ? 'active' : '') + '" value="' + esc(fv('badge')) + '"></div>' +
    '<div class="field"><label for="f-pin">PIN</label><input id="f-pin" data-f="pin" data-kf="pin" type="password" inputmode="numeric" autocomplete="off" class="' + (S.kfield === 'pin' ? 'active' : '') + '" value="' + esc(fv('pin')) + '"></div>' +
    '<div class="err" role="alert">' + esc(S.err) + '</div>';
}
function viewBoot(){ return '<div class="center"><div class="loadbox"><div class="eyebrow">GEORGIA STATE ROLEPLAY</div><h1 style="font-size:26px">Connecting to the CAD</h1></div></div>'; }
function viewSetup(){
  var dk = fv('s-dept') || 'LCSO';
  return '<div class="center"><section class="panel" style="width:100%;max-width:520px"><div><div class="eyebrow">FIRST TIME SETUP</div><h1 style="font-size:24px">Create the owner login</h1><div class="muted">This CAD has no logins yet. The login you create here is the owner and admin. Do this now, before you share the link.</div></div>' +
    field('s-badge','Your badge number','type="text" inputmode="numeric"') + field('s-name','Your name on the roster') + select('s-dept','Your department', deptOpts) + select('s-rank','Your rank', dept(dk).ranks) +
    field('s-pin','Choose a PIN, 4 to 6 digits','type="password" inputmode="numeric"') +
    '<div class="err" role="alert">' + esc(S.err) + '</div><button type="button" class="btn primary" data-act="setup">Create owner login</button></section></div>';
}
function viewLogin(){
  return '<div class="center"><div class="login"><div class="left">' +
    '<div><div class="eyebrow">GEORGIA STATE ROLEPLAY</div><h1 style="font-size:28px">CAD sign in</h1></div>' +
    '<div class="clock" id="clock"></div>' + badgePin() +
    '<button type="button" class="btn primary" style="min-height:52px;font-size:17px" data-act="login">Log in</button>' +
    (V.cfg.discordLogin ? '<a class="btn" style="display:flex;align-items:center;justify-content:center;text-decoration:none;min-height:48px" href="/api/discord/start">Log in with Discord</a>' : '') +
    '<div class="row"><button type="button" class="btn" style="flex:1 1 150px" data-act="civ">Civilian portal</button><button type="button" class="btn" style="flex:1 1 150px" data-act="roster">Department rosters</button></div>' +
    (installEvt ? '<button type="button" class="btn on" data-act="install">Install this app</button>' : '<div class="dim" style="font-size:13px">To install: on iPhone tap Share, then Add to Home Screen. On Android or PC use the browser menu, then Install app.</div>') +
    '</div>' + keypad(S.kfield === 'badge' ? 'Badge number' : 'PIN') + '</div></div>';
}
function viewLink(){
  var d = V.discord || {name:'', roles:[]};
  return '<div class="center"><div class="login"><div class="left">' +
    '<div><div class="eyebrow">DISCORD CONNECTED</div><h1 style="font-size:26px">Link your badge</h1></div>' +
    '<div class="muted">Signed in to Discord as <b>' + esc(d.name) + '</b>. ' + (d.inGuild ? (d.roles.length ? 'Department roles found: ' + d.roles.map(function(k){ return esc(dept(k).name); }).join(', ') + '.' : 'No department roles found on your account in the main server.') : 'You are not in the main GSRP Discord server.') + '</div>' +
    '<div class="muted">Enter the badge number and PIN an admin gave you. You only do this once.</div>' + badgePin() +
    '<button type="button" class="btn primary" style="min-height:52px;font-size:17px" data-act="link">Link and continue</button>' +
    '<button type="button" class="btn" data-act="logout">Cancel</button>' +
    '</div>' + keypad(S.kfield === 'badge' ? 'Badge number' : 'PIN') + '</div></div>';
}
function viewNewPin(){
  return '<div class="center"><div class="login"><div class="left">' +
    '<div><div class="eyebrow">FIRST SIGN IN</div><h1 style="font-size:28px">Pick your own PIN</h1></div>' +
    '<div class="muted">Your admin gave you a temporary PIN. Choose a new one with 4 to 6 digits. Admins can reset it but never see it.</div>' +
    '<div class="field"><label for="f-newpin">New PIN</label><input id="f-newpin" data-f="newpin" type="password" inputmode="numeric" autocomplete="off" class="active" value="' + esc(fv('newpin')) + '"></div>' +
    '<div class="err" role="alert">' + esc(S.err) + '</div>' +
    '<button type="button" class="btn primary" style="min-height:52px;font-size:17px" data-act="savepin">Save PIN and continue</button>' +
    '</div>' + keypad('New PIN') + '</div></div>';
}
var LOADSTEPS = [['Checking badge and PIN',25],['Checking your department roles',50],['Syncing units and calls from the server',75],['Connecting radio channels',100]];
function viewLoading(){
  return '<div class="center"><div class="loadbox">' +
    '<div><div class="eyebrow">GEORGIA STATE ROLEPLAY</div><h1 style="font-size:30px">Starting your shift</h1><div class="mono muted">Badge ' + esc(V.me.badge) + ' · ' + esc(V.me.rank) + ' ' + esc(V.me.name) + '</div></div>' +
    '<div><div class="bar" id="lbar" role="progressbar" aria-label="Loading CAD" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div style="width:0%"></div></div><div class="mono muted" id="lpct" style="text-align:right;margin-top:6px">0%</div></div>' +
    '<div style="display:flex;flex-direction:column;gap:8px">' + LOADSTEPS.map(function(s, i){
      return '<div class="step" id="ls' + i + '"><span>' + s[0] + '</span><span class="mono" style="font-weight:600;color:#8E949B">WAITING</span></div>';
    }).join('') + '</div></div></div>';
}
function updateLoading(){
  var b = $('#lbar'); if (!b) return;
  b.setAttribute('aria-valuenow', S.pct); b.firstChild.style.width = S.pct + '%'; $('#lpct').textContent = S.pct + '%';
  LOADSTEPS.forEach(function(s, i){
    var start = i ? LOADSTEPS[i - 1][1] : 0, el = $('#ls' + i), st = S.pct >= s[1] ? ['DONE','#6EE7A0','done'] : S.pct >= start ? ['WORKING','#FBBF24','work'] : ['WAITING','#8E949B',''];
    el.className = 'step ' + st[2]; el.lastChild.textContent = st[0]; el.lastChild.style.color = st[1];
  });
}
function viewUnits(){
  var me = V.me;
  var cards = DKEYS.map(function(k){
    var D = DEPTS[k], ok = hasRole(k);
    var mine = me.units.map(function(u, i){ return {u:u, i:i}; }).filter(function(x){ return x.u.agency === k; });
    var body = ok
      ? (mine.length ? mine.map(function(x){ return '<div class="row between" style="flex-wrap:nowrap"><span class="mono"><b>' + esc(x.u.unit) + '</b></span><button type="button" class="btn primary pill" data-act="duty" data-i="' + x.i + '">Go on duty</button></div>'; }).join('') : '<div class="dim" style="font-size:13px">No unit number yet. Add yours below.</div>') +
        '<div class="row" style="flex-wrap:nowrap;gap:8px"><input class="inp mono" id="uu-' + k + '" data-f="u-unit-' + k + '" aria-label="New unit number for ' + esc(D.name) + '" placeholder="Unit #" value="' + esc(fv('u-unit-' + k)) + '" autocomplete="off"><button type="button" class="btn" data-act="addunit" data-k="' + k + '">Add</button></div>'
      : '<div class="dim" style="font-size:13px">Locked. You need the <b>@' + esc(D.name) + '</b> role in the main GSRP Discord to open this CAD.</div>';
    return '<section class="panel dcard ' + (ok ? '' : 'locked') + '" style="border-top:3px solid ' + (ok ? D.color : 'var(--line2)') + '"><div class="row between"><h2 style="color:' + (ok ? D.color : 'var(--dim)') + '">' + esc(D.name) + '</h2><span class="tag" style="color:' + (ok ? 'var(--green-text)' : 'var(--dim)') + '">' + (ok ? 'ROLE FOUND' : 'NO ROLE') + '</span></div>' + body + '</section>';
  }).join('');
  return '<div class="page" style="max-width:1000px;padding-top:32px">' +
    '<div class="hero" style="text-align:center"><div class="eyebrow">GEORGIA STATE ROLEPLAY</div><h1 style="font-size:34px">Choose your CAD</h1><div class="muted">' + esc(me.rank) + ' ' + esc(me.name) + ' · Badge <span class="mono">' + esc(me.badge) + '</span></div>' +
    '<div class="dim" style="font-size:13px">' + (me.linked ? 'Your departments come from your roles in the main Discord server.' : V.cfg.discordLogin ? 'Log in with Discord once to sync your department roles.' : 'An admin sets which departments you can open.') + '</div></div>' +
    '<div class="dgrid">' + cards + '</div>' +
    '<div class="row between"><div class="row"><button type="button" class="btn" data-act="logout">Log out</button><button type="button" class="btn" data-act="roster">Rosters</button><button type="button" class="btn" data-act="civ">Civilian portal</button></div>' + (me.role === 'Admin' ? '<button type="button" class="btn" data-act="admin">Admin</button>' : '') + '</div></div>';
}
function tb(a, label, ic, cls){ return '<button type="button" class="tb ' + (cls || '') + '" data-act="' + a + '">' + icon(ic) + '<span>' + label + '</span></button>'; }
function viewCad(){
  var me = V.me, d = me.duty, st = STATUSES[d.si] || STATUSES[0], ac = d.call ? findCall(d.call) : null, dk = d.agency, D = dept(dk);
  var top = '<header class="topbar"><div class="brand">GSRP CAD <span style="color:' + D.color + ';font-size:12px;letter-spacing:.04em">' + esc(D.name).toUpperCase() + '</span></div>' +
    '<button type="button" class="tb" data-act="status" aria-label="Change status, now ' + st.label + '" style="min-width:104px;color:' + st.color + ';border-color:' + st.color + '"><span aria-hidden="true" style="width:8px;height:8px;border-radius:50%;background:' + st.color + '"></span><span>' + st.label + '</span></button>' +
    tb('nohome','Home','home','home') + tb('soon-map','Map','map') + (D.leo ? tb('run','Run Search','run', S.run.open ? 'on' : '') : '') + tb('selfdisp','Self Dispatch','disp') +
    tb('quick', D.quick[0], 'stop', 'blue') + tb('panic','Panic','panic','red' + (d.panic ? ' on' : '')) + tb('radio','Radio','radio', S.radio.open ? 'on' : '') + tb('roster','Roster','roster') +
    '<div class="clockbox"><b id="clock"></b><span class="dim" id="date" style="font-size:12px"></span></div></header>';
  var sub = '<div class="subbar"><button type="button" class="btn ghost" data-act="getcall">Get call</button>' +
    (D.leo ? '<button type="button" class="btn ghost" data-act="run">Record search</button>' : '') +
    (me.role === 'Admin' ? '<button type="button" class="btn ghost" data-act="admin">Admin</button>' : '') +
    '<button type="button" class="btn ghost" data-act="offduty">Go off duty</button><button type="button" class="btn ghost" data-act="logout">Log out</button>' +
    (S.online ? '' : '<span class="tag" style="color:var(--amber)">RECONNECTING</span>') +
    '<span style="margin-left:auto" class="row">' + deptTag(dk) + '<span class="chip">' + esc(d.unit) + ' · ' + esc(me.rank) + '</span></span></div>';
  var alerts = V.units.filter(function(u){ return u.panic; }).map(function(u){
    return '<div class="alert" role="alert">PANIC: ' + esc(u.unit) + ' (' + esc(u.name) + '), last postal ' + esc(u.postal || 'unknown') + '. All available units respond Code 3.' + (u.unit === d.unit ? ' Press Panic again to clear.' : '') + '</div>';
  }).join('');

  var callPanel = '<section class="panel"><div class="row between"><h2>' + (ac ? 'Active call #' + ac.id + ': ' + esc(ac.title) : 'No active call') + '</h2>' +
    '<button type="button" class="btn pill" data-act="selfclear"' + (ac ? '' : ' disabled style="opacity:.5"') + '>Self clear</button></div>' +
    (ac ? '<div class="muted">' + esc(ac.type) + ' · ' + esc(ac.code) + ' · ' + esc(ac.priority) + ' priority · Postal <span class="mono">' + esc(ac.postal || 'unknown') + '</span>' + (ac.address ? ' · ' + esc(ac.address) : '') + ' · Units <span class="mono">' + esc(ac.units.join(', ')) + '</span></div>' : '') +
    '<div class="form">' + select('c-type','Type (required)', D.types) + field('c-title','Call title (required)') + select('c-code','Code',['Code 1','Code 2','Code 3']) + select('c-pri','Priority',['Low','Medium','High']) + field('c-postal','Postal','type="text" inputmode="numeric"') + '</div>' +
    '<div class="row" style="align-items:flex-end"><div style="flex:1 1 240px">' + field('c-addr','Address') + '</div><button type="button" class="btn primary" data-act="createcall">Create call</button></div></section>';

  var codes = '<section class="panel"><h2>10-Codes</h2><input class="inp" id="codeq" data-f="codeq" aria-label="Search 10-codes" placeholder="Search" value="' + esc(fv('codeq')) + '" autocomplete="off">' +
    '<div class="tablewrap scroll"><table><thead><tr><th style="width:30%">Code</th><th>Name</th></tr></thead><tbody id="codebody">' + codeRows(fv('codeq')) + '</tbody></table></div></section>';

  var list = S.callTab === 'active' ? V.calls : V.history;
  var callRows = list.map(function(c){
    return '<tr class="' + (c.id === S.flashCall ? 'flash' : '') + '"><td class="mono">#' + c.id + '</td><td>' + esc(c.code) + '</td><td>' + esc(c.status) + '</td><td>' + esc(c.priority) + '</td><td>' + esc(c.type) + '</td><td>' + esc(c.title) + '</td><td class="mono">' + esc(c.postal || '') + '</td><td class="mono">' + hm(c.at) + '</td><td class="mono">' + (c.units.length ? esc(c.units.join(', ')) : 'None') + '</td>' +
      '<td>' + (S.callTab === 'active' && c.id !== d.call ? '<button type="button" class="btn pill" data-act="attach" data-id="' + c.id + '">Attach</button>' : '') + '</td></tr>';
  }).join('');
  S.flashCall = 0;
  var calls = '<section class="panel"><div class="row"><h2>Calls</h2>' +
    '<button type="button" class="btn pill ' + (S.callTab === 'active' ? 'on' : '') + '" data-act="tab-active">Active · ' + V.calls.length + '</button>' +
    '<button type="button" class="btn pill ' + (S.callTab === 'history' ? 'on' : '') + '" data-act="tab-history">History · ' + V.history.length + '</button>' +
    '<button type="button" class="btn pill" style="margin-left:auto" data-act="test911">Send test 911 call</button></div>' +
    '<div class="tablewrap"><table style="min-width:720px"><thead><tr><th>Call #</th><th>Code</th><th>Status</th><th>Priority</th><th>Type</th><th>Title</th><th>Postal</th><th>Time</th><th>Units</th><th></th></tr></thead><tbody>' + callRows + '</tbody></table>' +
    (list.length ? '' : '<div class="empty"><div style="font-size:16px;font-weight:600">No ' + (S.callTab === 'active' ? 'active calls' : 'call history') + ' to display</div><div class="dim">New 911 calls and dispatched calls show up here.</div></div>') + '</div></section>';

  var runPanel = '';
  if (S.run.open && D.leo){
    var ph = {Vehicle:'Plate', Name:'Civilian name', Licence:'Name on licence'}[S.run.tab];
    runPanel = '<section class="panel" style="border-color:var(--green)"><div class="row"><h2>Run</h2>' + ['Vehicle','Name','Licence'].map(function(t){
      return '<button type="button" class="btn pill ' + (t === S.run.tab ? 'on' : '') + '" data-act="runtab" data-t="' + t + '">' + t + '</button>'; }).join('') +
      '<button type="button" class="btn pill" style="margin-left:auto" data-act="run">Close</button></div>' +
      '<div class="row" style="flex-wrap:nowrap"><input class="inp mono" id="runq" data-f="runq" aria-label="' + S.run.tab + ' search" placeholder="' + ph + '" value="' + esc(fv('runq')) + '" autocomplete="off" style="border-radius:999px"><button type="button" class="btn primary pill" data-act="runsearch">Search records</button></div>' +
      (S.run.result || '') + '</section>';
  }
  var quickPanel = '';
  if (S.quick.open){
    quickPanel = '<section class="panel" style="border-color:var(--blue)"><div class="row between"><h2>Quick ' + esc(D.quick[0].toLowerCase()) + '</h2><button type="button" class="btn pill" data-act="quick">Close</button></div>' +
      '<input class="inp mono" id="quickq" data-f="quickq" aria-label="' + (D.leo ? 'Vehicle plate' : 'Postal') + '" placeholder="' + (D.leo ? 'Plate' : 'Postal') + '" value="' + esc(fv('quickq')) + '" autocomplete="off" style="border-radius:999px">' +
      '<div class="row"><button type="button" class="btn primary" style="flex:2 1 160px" data-act="mkquick">Create ' + esc(D.quick[1].toLowerCase()) + ' call</button>' + (D.leo ? '<button type="button" class="btn" style="flex:1 1 100px" data-act="mkquick-np">No plate</button>' : '') + '</div></section>';
  }
  var units = '<section class="panel"><div class="row between"><h2>Active units</h2><span class="dim" style="font-size:12px">' + V.units.length + ' on duty</span></div>' +
    '<div class="tablewrap"><table style="min-width:560px"><thead><tr><th>Unit</th><th>Call</th><th>Name</th><th>Location</th><th>Dept</th><th>Rank</th><th>Status</th></tr></thead><tbody>' +
    V.units.map(function(u){ var s2 = STATUSES[u.si] || STATUSES[0]; return '<tr><td>' + (u.unit === d.unit ? '<span class="chip">' + esc(u.unit) + '</span>' : '<span class="mono"><b>' + esc(u.unit) + '</b></span>') + '</td><td class="mono">' + (u.call ? '#' + u.call : 'None') + '</td><td>' + esc(u.name) + '</td><td class="mono">' + (u.postal ? 'Postal ' + esc(u.postal) : 'Unknown') + '</td><td>' + deptTag(u.agency) + '</td><td>' + esc(u.rank) + '</td><td class="mono" style="font-weight:600;color:' + (u.panic ? '#FF8A8A' : s2.color) + '">' + (u.panic ? 'PANIC' : s2.label.toUpperCase()) + '</td></tr>'; }).join('') +
    '</tbody></table></div></section>';

  return top + sub + alerts + '<div class="grid"><div class="col main">' + callPanel + codes + calls + '</div><div class="col side">' + runPanel + quickPanel + units + '</div></div>';
}
function codeRows(q){
  q = String(q || '').trim().toLowerCase();
  var rows = CODES.filter(function(c){ return !q || c[0].indexOf(q) !== -1 || c[1].toLowerCase().indexOf(q) !== -1; });
  return rows.length ? rows.map(function(c){ return '<tr><td class="mono">' + c[0] + '</td><td>' + c[1] + '</td></tr>'; }).join('') : '<tr><td colspan="2" class="dim">No code matches that search.</td></tr>';
}
function sw(a, on, title, desc){
  return '<button type="button" class="switch" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" data-act="' + a + '"><i aria-hidden="true"></i><span><b style="display:block">' + title + ': ' + (on ? 'On' : 'Off') + '</b><span class="muted" style="font-size:13px">' + desc + '</span></span></button>';
}
function viewAdmin(){
  var A = V.admin; if (!A) return viewUnits();
  var colors = {'Active':'#6EE7A0','Must change PIN':'#FBBF24','Disabled':'#8E949B'};
  var tabs = [['members','Members and logins'],['ai','Dispatch'],['discord','Discord']];
  var head = '<header class="panel"><div class="row between"><div><div class="eyebrow">GEORGIA STATE ROLEPLAY · ADMIN</div><h1 style="font-size:22px">Admin panel</h1></div><button type="button" class="btn" data-act="backcad">Back to CAD</button></div>' +
    '<div class="row">' + tabs.map(function(t){ return '<button type="button" class="btn pill ' + (S.adminTab === t[0] ? 'on' : '') + '" data-act="atab" data-t="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '<button type="button" class="btn pill" data-act="roster">Rosters</button></div></header>';
  if (S.adminTab === 'ai'){
    return '<div class="page">' + head + '<section class="panel"><h2>Dispatch</h2><div class="muted">Turn the automatic dispatcher on or off in each place. The two switches are independent.</div>' +
      sw('ai-radio', V.cfg.aiRadio, 'CAD radio', 'Answers units on the CAD radio for every department: status changes, plates and names, traffic stops, getting and clearing calls.') +
      sw('ai-discord', V.cfg.aiDiscord, 'Discord', 'Turns on the voice dispatch bot in your Discord voice channel (when it is running) and, if a webhook is saved, posts radio traffic, 911 calls and panic alerts into your Discord text channel.') +
      '<div class="note">This build uses a scripted dispatcher, which is free. It understands radio phrases such as 10-8, 10-97, 10-23, "run plate ABC123", "traffic stop", "any calls" and "clear".</div></section></div>';
  }
  if (S.adminTab === 'discord'){
    var cb = location.origin + '/api/discord/callback';
    return '<div class="page">' + head + '<section class="panel"><h2>Discord login and roles</h2>' +
      '<div class="muted">With this set up, members press "Log in with Discord" and the CAD reads their roles in your main server to decide which departments they can open.</div>' +
      '<div class="note">In the Discord Developer Portal, open your application, go to OAuth2, and add this redirect link exactly:<br><b class="mono" style="word-break:break-all">' + esc(cb) + '</b></div>' +
      '<div class="form">' + field('d-client','Application (client) ID','type="text" inputmode="numeric" class="mono"') + field('d-secret','Client secret' + (A.discord.secretSet ? ' (saved, leave blank to keep)' : ''),'type="password"') + field('d-guild','Main server ID','type="text" inputmode="numeric" class="mono"') + '</div>' +
      '<h2 style="margin-top:6px">Role IDs</h2><div class="muted">Paste the Discord role ID that unlocks each department. Leave one blank if you do not use it.</div>' +
      '<div class="form">' + DKEYS.map(function(k){ return field('d-role-' + k, esc(DEPTS[k].name) + ' role ID', 'type="text" inputmode="numeric" class="mono"'); }).join('') + field('d-role-ADMIN','CAD admin role ID','type="text" inputmode="numeric" class="mono"') + '</div>' +
      '<h2 style="margin-top:6px">Dispatch channel webhook</h2><div class="muted">' + (V.cfg.webhookSet ? 'A webhook is saved. Paste a new one to replace it.' : 'Paste a webhook link from the Discord channel where dispatch should post.') + '</div>' +
      field('d-hook','Webhook link','type="password"') +
      '<div class="err" role="alert">' + esc(S.err) + '</div><div class="row"><button type="button" class="btn primary" data-act="savediscord">Save Discord settings</button>' + (V.cfg.webhookSet ? '<button type="button" class="btn" data-act="clearhook">Remove webhook</button>' : '') + '</div></section>' +
      '<section class="panel"><h2>Voice dispatch bot</h2><div class="muted">The voice bot runs on your PC during sessions and sits in a Discord voice channel. It needs a key to reach this CAD. ' + (V.cfg.botKeySet ? 'A key exists. Creating a new one stops the old one working.' : 'No key has been created yet.') + '</div>' +
      (S.botKey ? '<div class="note" role="status" style="border-color:var(--green);color:var(--text)">Bot key, shown only once. Put it in the bot\'s settings file as CAD_BOT_KEY:<br><b class="mono" style="word-break:break-all">' + esc(S.botKey) + '</b></div>' : '') +
      '<div class="row"><button type="button" class="btn" data-act="botkey">' + (V.cfg.botKeySet ? 'Create a new bot key' : 'Create bot key') + '</button></div>' +
      '<div class="dim" style="font-size:13px">The bot only answers while the Discord switch on the Dispatch tab is on. Members must use "Log in with Discord" once so the bot knows which unit is speaking.</div></section></div>';
  }
  var rows = A.accounts.map(function(a){
    return '<tr><td class="mono"><b>' + esc(a.badge) + '</b></td><td>' + esc(a.name) + '</td><td>' + deptTag(a.dept) + '</td><td>' + esc(a.rank) + '</td><td>' + esc(a.role) + '</td>' +
      '<td><div class="row" style="gap:4px;flex-wrap:nowrap">' + DKEYS.map(function(k){ var on = a.roles.indexOf(k) !== -1; return '<button type="button" class="btn pill ' + (on ? 'on' : '') + '" style="padding:0 10px;font-size:12px" aria-pressed="' + on + '" data-act="trole" data-b="' + esc(a.badge) + '" data-k="' + k + '">' + k + '</button>'; }).join('') + '</div></td>' +
      '<td>' + (a.linked ? '<button type="button" class="btn pill" style="font-size:12px" data-act="unlink" data-b="' + esc(a.badge) + '">Unlink</button>' : '<span class="dim">Not linked</span>') + '</td>' +
      '<td style="font-weight:600;color:' + colors[a.status] + '">' + a.status + '</td>' +
      '<td><div class="row" style="flex-wrap:nowrap"><button type="button" class="btn" data-act="resetpin" data-b="' + esc(a.badge) + '">Reset PIN</button><button type="button" class="btn" data-act="toggleacct" data-b="' + esc(a.badge) + '">' + (a.status === 'Disabled' ? 'Enable' : 'Disable') + '</button></div></td></tr>';
  }).join('');
  var dk = fv('a-dept') || 'LCSO';
  return '<div class="page">' + head +
    (S.adminNote ? '<div class="note" role="status" style="border-color:var(--green);color:var(--text)">' + S.adminNote + '</div>' : '') +
    '<div class="row" style="align-items:flex-start;gap:16px"><section class="panel" style="flex:1 1 300px"><h2>Create a login</h2>' +
    field('a-badge','Badge number (what they sign in with)','type="text" inputmode="numeric"') + field('a-name','Name shown on the roster') + field('a-unit','Unit number / callsign') +
    select('a-dept','Department', deptOpts) + select('a-rank','Rank', dept(dk).ranks) + select('a-role','CAD role',['Officer','Dispatcher','Supervisor','Admin']) +
    '<div class="dim" style="font-size:13px">A temporary PIN is made for you and shown once. The member picks their own PIN at first sign in and joins the roster right away.</div>' +
    '<div class="err" role="alert">' + (S.errAt === 'acct' ? esc(S.err) : '') + '</div><button type="button" class="btn primary" data-act="mkacct">Create login</button></section>' +
    '<section class="panel" style="flex:1 1 300px"><h2>Link Discord for voice dispatch</h2><div class="muted" style="font-size:13px">The voice bot needs to know which Discord account belongs to which badge. In Discord, right-click the member\'s name and choose Copy User ID (Developer Mode must be on).</div>' +
    field('l-badge','Badge number','type="text" inputmode="numeric"') + field('l-id','Discord user ID','type="text" inputmode="numeric" class="mono"') +
    '<div class="err" role="alert">' + (S.errAt === 'linkd' ? esc(S.err) : '') + '</div><button type="button" class="btn primary" data-act="linkdiscord">Link Discord account</button></section>' +
    '<section class="panel" style="flex:999 1 520px"><div class="row between"><h2>All logins</h2><span class="dim">' + A.accounts.length + ' members</span></div>' +
    '<div class="tablewrap"><table style="min-width:1120px"><thead><tr><th>Badge</th><th>Name</th><th>Dept</th><th>Rank</th><th>CAD role</th><th>Departments' + (V.cfg.discordLogin ? ' (synced from Discord at login)' : '') + '</th><th>Discord</th><th>Login</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div></section></div></div>';
}
function viewRoster(){
  var dk = S.rosterDept, D = dept(dk);
  var people = V.roster.filter(function(a){ return a.dept === dk; });
  var groups = D.ranks.map(function(r){
    var ms = people.filter(function(p){ return p.rank === r; });
    return '<div class="rank"><h3>' + pips(dk, r) + '<span>' + esc(r).toUpperCase() + '</span><span class="dim">' + ms.length + '</span></h3>' +
      (ms.length ? ms.map(function(p){
        return '<div class="member ' + (p.badge === S.newBadge ? 'flash' : '') + '"><b>' + esc(p.name) + '</b><span class="mono muted">' + esc(p.unit || 'No unit') + '</span><span class="mono dim">Badge ' + esc(p.badge) + '</span>' +
          (p.badge === S.newBadge ? '<span class="tag" style="margin-left:auto;color:var(--green-text)">NEW</span>' : '') + '</div>';
      }).join('') : '<div class="dim" style="font-size:13px;padding-left:2px">Vacant</div>') + '</div>';
  }).join('');
  return '<div class="page"><header class="panel"><div class="row between"><div><div class="eyebrow">GEORGIA STATE ROLEPLAY</div><h1 style="font-size:22px">Department rosters</h1></div><button type="button" class="btn" data-act="back">Back</button></div>' +
    '<div class="row">' + DKEYS.map(function(k){ return '<button type="button" class="btn pill ' + (k === dk ? 'on' : '') + '" data-act="rdept" data-k="' + k + '">' + esc(DEPTS[k].name) + '</button>'; }).join('') + '</div></header>' +
    '<section class="panel"><div class="row between"><h2 style="font-size:17px;color:' + D.color + '">' + esc(D.name) + '</h2><span class="dim">' + people.length + ' members</span></div>' + groups + '</section></div>';
}
function viewCiv(){
  var mine = V.civs;
  var cards = mine.map(function(c){
    return '<div class="idcard"><div class="hd"><span>STATE OF GEORGIA (ROLEPLAY)</span><span>DRIVER LICENCE</span></div>' +
      '<div><div style="font-size:19px;font-weight:700">' + esc(c.name) + '</div><div class="mono muted">DOB ' + esc(c.dob) + ' · ID ' + String(1000 + c.id) + '</div></div>' +
      '<div class="row"><span class="tag" style="color:#6EE7A0">LICENCE ' + esc(c.licence).toUpperCase() + '</span><span class="dim" style="font-size:12px">' + c.vehicles.length + ' vehicle' + (c.vehicles.length === 1 ? '' : 's') + '</span></div>' +
      (c.vehicles.length ? '<div class="tablewrap"><table><tbody>' + c.vehicles.map(function(v){ return '<tr><td class="mono"><b>' + esc(v.plate) + '</b></td><td>' + esc(v.color) + ' ' + esc(v.model) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '') + '</div>';
  }).join('');
  var charOpts = mine.map(function(c){ return {v:String(c.id), t:c.name}; });
  return '<div class="page"><header class="panel"><div class="row between"><div><div class="eyebrow">GEORGIA STATE ROLEPLAY</div><h1 style="font-size:22px">Civilian portal</h1><div class="muted">Register your character and vehicles before you join a session. Officers can then run your name and plate.</div></div><button type="button" class="btn" data-act="back">Back</button></div></header>' +
    '<div class="row" style="align-items:flex-start;gap:16px">' +
    '<section class="panel" style="flex:1 1 300px"><h2>Register a character</h2>' + field('v-name','Character name') + field('v-dob','Character date of birth','type="text" placeholder="MM/DD/YYYY"') +
    '<div class="dim" style="font-size:13px">Use a made-up roleplay name and birthday, never your real ones.</div><div class="err" role="alert">' + (S.errAt === 'civ' ? esc(S.err) : '') + '</div><button type="button" class="btn primary" data-act="mkciv">Register character</button></section>' +
    '<section class="panel" style="flex:1 1 300px"><h2>Register a vehicle</h2>' +
    (mine.length ? select('v-owner','Owner', charOpts) + field('v-plate','Plate','type="text" class="mono"') + field('v-model','Vehicle model') + field('v-color','Color') +
      '<div class="err" role="alert">' + (S.errAt === 'veh' ? esc(S.err) : '') + '</div><button type="button" class="btn primary" data-act="mkveh">Register vehicle</button>'
      : '<div class="dim">Register a character first, then add their vehicles here.</div>') + '</section></div>' +
    '<section class="panel"><div class="row between"><h2>My characters</h2><span class="dim">' + mine.length + ' registered</span></div>' +
    (mine.length ? '<div class="row" style="align-items:stretch">' + cards + '</div>' : '<div class="empty" style="border:1px solid var(--line);border-radius:10px"><div style="font-size:16px;font-weight:600">No characters yet</div><div class="dim">Your licence card shows up here after you register. Characters are saved to this device' + (V.me ? ' and your badge' : '') + '.</div></div>') + '</section></div>';
}

/* ---------- radio ---------- */
var SR = window.SpeechRecognition || window.webkitSpeechRecognition, rec = null, recText = '';
function radioHtml(){
  var r = S.radio, d = V.me.duty, joined = r.joined === r.sel, any = r.joined !== -1;
  var led = r.tx ? ['TX','#FF8A8A'] : any ? ['RX','#6EE7A0'] : ['OFF','#8E949B'];
  var hint = r.tx ? (SR ? 'Listening to you…' : 'Keyed up on ' + CHANNELS[r.joined].name) : any ? 'On ' + CHANNELS[r.joined].name + '. ' + (SR ? 'Hold F and speak, or type.' : 'Type your radio traffic.') : 'Not connected. Join a channel.';
  var list = any ? (V.radio[String(r.joined)] || []) : [];
  var log = !any ? '<div class="dim" style="font-size:12px">Join a channel to see its radio traffic.</div>'
    : list.length ? list.map(function(x){
        var fresh = r.seen && x.id > r.seen;
        return '<div class="msg ' + (x.kind === 'd' ? 'd' : 'u') + ' ' + (fresh ? 'new' : '') + '"><span class="who">' + esc(x.who) + ' · ' + hm(x.at) + '</span><span>' + esc(x.text) + '</span></div>';
      }).join('')
    : '<div class="dim" style="font-size:12px">No traffic yet. Try: "Dispatch, show me 10-8" or "run plate ABC123".</div>';
  if (any && list.length) r.seen = Math.max(r.seen, list[list.length - 1].id); else if (any && !r.seen) r.seen = 1;
  return '<section class="radio ' + (r.pop ? 'pop' : '') + '" aria-label="Radio">' +
    '<div class="title"><span class="row" style="gap:8px"><span style="width:16px;height:16px;display:inline-flex">' + icon('radio') + '</span>Radio<span class="tag" style="color:' + (V.cfg.aiRadio ? 'var(--green-text)' : 'var(--dim)') + '">DISPATCH ' + (V.cfg.aiRadio ? 'ON' : 'OFF') + '</span></span>' +
    '<span class="row" style="gap:2px"><span class="led ' + (r.tx ? 'tx' : '') + '" style="color:' + led[1] + '"><i></i>' + led[0] + '</span><button type="button" class="btn ghost" aria-pressed="' + S.voice + '" data-act="voice" style="padding:0 8px">Voice ' + (S.voice ? 'on' : 'off') + '</button><button type="button" class="btn ghost" aria-label="Close radio" data-act="radio" style="padding:0 8px">Close</button></span></div>' +
    '<div class="cur"><select class="inp" id="rch" aria-label="Radio channel" style="flex:1;min-width:0">' + CHANNELS.map(function(c, i){ return '<option value="' + i + '"' + (i === r.sel ? ' selected' : '') + '>' + c.name + ' · ' + c.freq + (r.joined === i ? ' · connected' : '') + '</option>'; }).join('') + '</select>' +
    '<button type="button" class="btn pill ' + (joined ? '' : 'primary') + '" data-act="join">' + (joined ? 'Leave' : 'Join') + '</button></div>' +
    '<div class="log" id="rlog" aria-live="polite">' + log + '</div>' +
    '<div class="foot"><div class="mono muted" id="rhint" style="font-size:11px">' + esc(hint) + '</div>' +
    '<div class="row" style="flex-wrap:nowrap;gap:8px"><input class="inp" id="radiomsg" data-f="radiomsg" aria-label="Radio message" placeholder="Type radio traffic" value="' + esc(fv('radiomsg')) + '" autocomplete="off"><button type="button" class="btn" data-act="rsend">Send</button></div>' +
    '<button type="button" id="ptt" class="ptt ' + (r.tx ? 'tx' : '') + '" aria-pressed="' + r.tx + '"><span>' + (r.tx ? 'TRANSMITTING' : 'HOLD TO TALK') + '</span><kbd>F</kbd></button></div></section>' + '<span hidden>' + esc(d.unit) + '</span>';
}
function paintRadio(){
  var m = $('#radioMount');
  if (S.screen !== 'cad' || !S.radio.open || !V.me || !V.me.duty){ m.innerHTML = ''; return; }
  m.innerHTML = radioHtml(); S.radio.pop = false;
  var lg = $('#rlog'); if (lg) lg.scrollTop = lg.scrollHeight;
}
function sendRadio(text){
  text = String(text || '').trim();
  if (!text) return;
  if (S.radio.joined === -1){ toast('Join a channel first.'); return; }
  beep(700, 100);
  act('radio', {ch:S.radio.joined, text:text});
}
function txStart(){
  var r = S.radio;
  if (S.screen !== 'cad' || !r.open) return;
  if (r.joined === -1){ toast('Join a channel first, then hold F to talk.'); return; }
  if (r.tx) return;
  r.tx = true; beep(1200, 90);
  if (SR){
    try{
      rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US'; recText = '';
      rec.onresult = function(e){ var t = ''; for (var i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; recText = t; var h = $('#rhint'); if (h && S.radio.tx) h.textContent = t; };
      rec.onerror = function(){};
      rec.start();
    }catch(e){ rec = null; }
  }
  keepFocus(paintRadio);
}
function txStop(){
  var r = S.radio; if (!r.tx) return;
  r.tx = false; beep(700, 120);
  if (rec){
    var x = rec; rec = null;
    x.onend = function(){ var t = recText.trim(); recText = ''; if (t) sendRadio(t); };
    try{ x.stop(); }catch(e){}
  } else if (!SR){ var i = $('#radiomsg'); keepFocus(paintRadio); i = $('#radiomsg'); if (i) i.focus(); return; }
  keepFocus(paintRadio);
}

/* ---------- drawing ---------- */
function keepFocus(fn){
  var ae = document.activeElement, id = ae && ae.id, a, b;
  if (id){ try{ a = ae.selectionStart; b = ae.selectionEnd; }catch(e){} }
  fn();
  if (id){ var n = document.getElementById(id); if (n && n !== document.activeElement){ try{ n.focus({preventScroll:true}); if (a != null) n.setSelectionRange(a, b); }catch(e){} } }
}
var VIEWS = {boot:viewBoot, setup:viewSetup, login:viewLogin, link:viewLink, newpin:viewNewPin, loading:viewLoading, units:viewUnits, cad:viewCad, admin:viewAdmin, roster:viewRoster, civ:viewCiv};
function render(){
  if (S.screen === 'loading' && $('#lbar')) { updateLoading(); return; }
  if (MEMBER[S.screen] && !V.me) S.screen = 'login';
  if (S.screen === 'cad' && !V.me.duty) S.screen = 'units';
  keepFocus(function(){ $('#app').innerHTML = VIEWS[S.screen](); paintRadio(); });
  tick();
}
function tick(){
  var d = new Date(), c = $('#clock'), dt = $('#date');
  if (c) c.textContent = S.screen === 'cad' ? d.toLocaleTimeString('en-US', {hour12:false}) : d.toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit', second:'2-digit'});
  if (dt) dt.textContent = d.toLocaleDateString('en-US');
}
setInterval(tick, 1000);
var enterTimer;
function go(screen){
  if (screen === 'roster' || screen === 'civ'){ if (S.screen !== 'roster' && S.screen !== 'civ') S.back = S.screen; }
  S.screen = screen; S.err = ''; S.errAt = '';
  var app = $('#app'); app.classList.remove('enter'); void app.offsetWidth; app.classList.add('enter');
  clearTimeout(enterTimer); enterTimer = setTimeout(function(){ app.classList.remove('enter'); }, 700);
  render(); window.scrollTo(0, 0);
}
function startLoading(){
  S.pct = 0; go('loading'); connect();
  var t = setInterval(function(){
    if (S.screen !== 'loading'){ clearInterval(t); return; }
    S.pct = Math.min(100, S.pct + 4); updateLoading();
    if (S.pct >= 100){ clearInterval(t); setTimeout(function(){ if (S.screen === 'loading') go('units'); }, 500); }
  }, 110);
}
function afterAuth(){
  S.f.pin = ''; S.f.newpin = '';
  if (!V.me){ go(V.discord ? 'link' : 'login'); return; }
  if (V.me.mustChange) go('newpin'); else startLoading();
}
function resultTable(rows){ return '<div class="tablewrap"><table><tbody>' + rows.map(function(r){ return '<tr><th>' + r[0] + '</th><td' + (r[2] ? ' style="font-weight:600;color:' + r[2] + '"' : '') + (r[3] ? ' class="mono"' : '') + '>' + esc(r[1]) + '</td></tr>'; }).join('') + '</tbody></table></div>'; }
function good(v, ok){ return v === ok ? '#6EE7A0' : '#FF8A8A'; }

/* ---------- actions ---------- */
var installEvt = null;
var A = {
  key: function(el){
    var k = el.dataset.k, f = S.screen === 'newpin' ? 'newpin' : S.kfield;
    if (k === 'Del') S.f[f] = fv(f).slice(0, -1);
    else if (k === 'Next'){ if (S.screen !== 'newpin') S.kfield = S.kfield === 'badge' ? 'pin' : 'badge'; }
    else if (fv(f).length < 6) S.f[f] = fv(f) + k;
    render();
  },
  setup: function(){ act('setup', {badge:fv('s-badge'), name:fv('s-name'), dept:fv('s-dept') || 'LCSO', rank:fv('s-rank'), pin:fv('s-pin')}, {errAt:'setup', then:function(){ S.f['s-pin'] = ''; startLoading(); }}); },
  login: function(){ act('login', {badge:fv('badge'), pin:fv('pin')}, {errAt:'login', then:afterAuth}); },
  link: function(){ act('link', {badge:fv('badge'), pin:fv('pin')}, {errAt:'link', then:afterAuth}); },
  savepin: function(){ act('setpin', {pin:fv('newpin')}, {errAt:'pin', then:function(){ S.f.newpin = ''; startLoading(); }}); },
  logout: function(){ S.radio.open = false; S.radio.joined = -1; S.radio.tx = false; S.radio.seen = 0; S.f.badge = ''; S.f.pin = ''; S.kfield = 'badge'; closeSocket(); rpc('logout').catch(function(){}).then(function(){ go('login'); }); },
  install: function(){ if (installEvt){ installEvt.prompt(); installEvt = null; render(); } },
  duty: function(el){ act('duty', {i:+el.dataset.i}, {then:function(){ var d = V.me && V.me.duty; if (d){ S.radio.sel = dept(d.agency).ch; S.run.open = false; S.quick.open = false; go('cad'); } }}); },
  offduty: function(){ S.radio.open = false; S.radio.joined = -1; S.radio.seen = 0; act('offduty', {}, {then:function(){ go('units'); }}); },
  addunit: function(el){ var k = el.dataset.k; act('addunit', {agency:k, unit:fv('u-unit-' + k)}, {then:function(){ S.f['u-unit-' + k] = ''; }}); },
  units: function(){ go('units'); },
  roster: function(){ if (V.me && V.me.duty && S.screen === 'cad') S.rosterDept = V.me.duty.agency; go('roster'); },
  rdept: function(el){ S.rosterDept = el.dataset.k; render(); },
  civ: function(){ go('civ'); },
  back: function(){ var b = S.back; go(b === 'cad' || b === 'units' || b === 'admin' ? (V.me ? b : 'login') : 'login'); },
  status: function(){ act('status', {si:(V.me.duty.si + 1) % STATUSES.length}); },
  nohome: function(){ window.scrollTo({top:0, behavior:'smooth'}); },
  'soon-map': function(){ toast('The live map is not built yet.'); },
  run: function(){ S.run.open = !S.run.open; S.run.result = null; render(); },
  runtab: function(el){ S.run.tab = el.dataset.t; S.run.result = null; S.f.runq = ''; render(); },
  runsearch: function(){
    var q = fv('runq').trim(), veh = S.run.tab === 'Vehicle';
    if (!q){ toast('Type something to search for.'); return; }
    act(veh ? 'runplate' : 'runname', {q:q}, {then:function(j){
      var r = j.result || {};
      S.run.result = !r.found ? '<div class="note">No record found for "' + esc(q) + '". Civilians register their characters and vehicles in the Civilian portal.</div>'
        : veh ? resultTable([['Plate', r.plate, '', 1], ['Vehicle', r.vehicle], ['Owner', r.owner], ['Registration', r.registration], ['Flags', r.flags, good(r.flags, 'None')]])
        : resultTable([['Name', r.name], ['Date of birth', r.dob, '', 1], ['Licence', r.licence, good(r.licence, 'Valid')], ['Warrants', r.warrants, good(r.warrants, 'None')], ['Vehicles', r.vehicles.length ? r.vehicles.join(', ') : 'None', '', 1]]);
    }});
  },
  quick: function(){ S.quick.open = !S.quick.open; render(); },
  mkquick: function(){ act('quick', {q:fv('quickq')}, {then:function(){ S.quick.open = false; S.f.quickq = ''; S.callTab = 'active'; }}); },
  'mkquick-np': function(){ act('quick', {np:true}, {then:function(){ S.quick.open = false; S.callTab = 'active'; }}); },
  selfdisp: function(){ var t = $('#f-c-title'); if (t){ t.scrollIntoView({block:'center', behavior:'smooth'}); t.focus(); } },
  createcall: function(){
    act('createcall', {title:fv('c-title'), type:fv('c-type') || dept(V.me.duty.agency).types[0], code:fv('c-code') || 'Code 1', priority:fv('c-pri') || 'Low', postal:fv('c-postal'), address:fv('c-addr')},
      {then:function(){ S.f['c-title'] = ''; S.f['c-postal'] = ''; S.f['c-addr'] = ''; S.callTab = 'active'; }});
  },
  selfclear: function(){ act('selfclear'); },
  getcall: function(){ act('getcall'); },
  attach: function(el){ act('attach', {id:+el.dataset.id}); },
  test911: function(){ S.callTab = 'active'; act('test911'); },
  'tab-active': function(){ S.callTab = 'active'; render(); },
  'tab-history': function(){ S.callTab = 'history'; render(); },
  panic: function(){ act('panic'); },
  radio: function(){ S.radio.open = !S.radio.open; S.radio.tx = false; S.radio.pop = S.radio.open; render(); },
  voice: function(){ S.voice = !S.voice; try{ localStorage.setItem('gsrp-voice', S.voice ? '1' : '0'); }catch(e){} if (S.voice) speak('Radio voice on.'); keepFocus(paintRadio); },
  join: function(){
    var r = S.radio; r.tx = false; r.joined = r.joined === r.sel ? -1 : r.sel; r.seen = 0; beep(r.joined === -1 ? 500 : 1000, 80);
    if (r.joined !== -1){ var l = V.radio[String(r.joined)] || []; r.seen = l.length ? l[l.length - 1].id : 1; }
    keepFocus(paintRadio);
  },
  rsend: function(){ var t = fv('radiomsg'); if (!t.trim()) return; S.f.radiomsg = ''; var i = $('#radiomsg'); if (i) i.value = ''; sendRadio(t); },
  admin: function(){ S.adminNote = ''; go('admin'); },
  backcad: function(){ go(V.me && V.me.duty ? 'cad' : 'units'); },
  atab: function(el){
    S.adminTab = el.dataset.t; S.err = '';
    if (S.adminTab === 'discord' && V.admin && S.f['d-client'] === undefined){
      var d = V.admin.discord; S.f['d-client'] = d.clientId; S.f['d-guild'] = d.guildId;
      DKEYS.concat(['ADMIN']).forEach(function(k){ S.f['d-role-' + k] = d.roleMap[k] || ''; });
    }
    render();
  },
  botkey: function(){ act('botkey', {}, {then:function(j){ S.botKey = j.key; }}); },
  'ai-radio': function(){ act('setcfg', {aiRadio:!V.cfg.aiRadio}); },
  'ai-discord': function(){ act('setcfg', {aiDiscord:!V.cfg.aiDiscord}); },
  savediscord: function(){
    var map = {}; DKEYS.concat(['ADMIN']).forEach(function(k){ map[k] = fv('d-role-' + k).trim(); });
    act('setdiscord', {clientId:fv('d-client').trim(), secret:fv('d-secret').trim(), guildId:fv('d-guild').trim(), roleMap:map, webhook:fv('d-hook').trim()}, {errAt:'discord', then:function(){ S.f['d-secret'] = ''; S.f['d-hook'] = ''; toast('Discord settings saved.'); }});
  },
  clearhook: function(){ var map = {}; DKEYS.concat(['ADMIN']).forEach(function(k){ map[k] = fv('d-role-' + k).trim(); }); act('setdiscord', {clientId:fv('d-client').trim(), guildId:fv('d-guild').trim(), roleMap:map, clearWebhook:true}, {errAt:'discord'}); },
  mkacct: function(){
    act('mkacct', {badge:fv('a-badge'), name:fv('a-name'), unit:fv('a-unit'), dept:fv('a-dept') || 'LCSO', rank:fv('a-rank'), role:fv('a-role') || 'Officer'}, {errAt:'acct', then:function(j){
      S.newBadge = j.badge; S.rosterDept = j.dept;
      S.adminNote = 'Login created and added to the ' + esc(dept(j.dept).name) + ' roster as ' + esc(j.rank) + '. Give them badge <b class="mono">' + esc(j.badge) + '</b> and temporary PIN <b class="mono">' + esc(j.pin) + '</b>. It is shown only once. <button type="button" class="btn pill" data-act="roster" style="margin-left:6px">View roster</button>';
      ['a-badge','a-name','a-unit'].forEach(function(k){ S.f[k] = ''; });
    }});
  },
  resetpin: function(el){ act('resetpin', {badge:el.dataset.b}, {then:function(j){ S.adminNote = 'PIN reset for badge <b class="mono">' + esc(j.badge) + '</b>. New temporary PIN: <b class="mono">' + esc(j.pin) + '</b>. It is shown only once.'; }}); },
  toggleacct: function(el){ act('toggleacct', {badge:el.dataset.b}); },
  trole: function(el){ act('trole', {badge:el.dataset.b, k:el.dataset.k}); },
  linkdiscord: function(){ act('linkdiscord', {badge:fv('l-badge'), discordId:fv('l-id').trim()}, {errAt:'linkd', then:function(j){ S.f['l-badge'] = ''; S.f['l-id'] = ''; toast('Linked ' + j.name + ' for voice dispatch.'); }}); },
  unlink: function(el){ act('unlink', {badge:el.dataset.b}); },
  mkciv: function(){ act('mkciv', {name:fv('v-name'), dob:fv('v-dob')}, {errAt:'civ', then:function(j){ S.f['v-name'] = ''; S.f['v-dob'] = ''; S.f['v-owner'] = String(j.id); toast('Character registered with a valid licence.'); }}); },
  mkveh: function(){ act('mkveh', {id:+(fv('v-owner') || (V.civs[0] || {}).id || 0), plate:fv('v-plate'), model:fv('v-model'), color:fv('v-color')}, {errAt:'veh', then:function(){ S.f['v-plate'] = ''; S.f['v-model'] = ''; S.f['v-color'] = ''; toast('Vehicle registered.'); }}); }
};

/* ---------- events ---------- */
document.addEventListener('click', function(e){
  var el = e.target.closest('[data-act]');
  if (el && !el.disabled && A[el.dataset.act]) A[el.dataset.act](el);
});
document.addEventListener('input', function(e){
  var t = e.target;
  if (t.dataset && t.dataset.f){
    var v = t.value;
    if (t.inputMode === 'numeric' && /badge|pin/.test(t.dataset.f)) { v = v.replace(/\D/g, '').slice(0, 6); t.value = v; }
    S.f[t.dataset.f] = v;
  }
  if (t.id === 'codeq') $('#codebody').innerHTML = codeRows(t.value);
});
document.addEventListener('change', function(e){
  var t = e.target;
  if (t.id === 'f-a-dept'){ S.f['a-dept'] = t.value; S.f['a-rank'] = ''; render(); }
  if (t.id === 'f-s-dept'){ S.f['s-dept'] = t.value; S.f['s-rank'] = ''; render(); }
  if (t.id === 'rch'){ S.radio.sel = +t.value; keepFocus(paintRadio); }
});
document.addEventListener('focusin', function(e){
  var kf = e.target.dataset && e.target.dataset.kf;
  if (kf && S.kfield !== kf){
    S.kfield = kf;
    document.querySelectorAll('[data-kf]').forEach(function(i){ i.classList.toggle('active', i.dataset.kf === kf); });
    var b = document.querySelector('.keypad b'); if (b) b.textContent = kf === 'badge' ? 'Badge number' : 'PIN';
  }
});
function typing(e){ var n = e.target && e.target.tagName; return n === 'INPUT' || n === 'SELECT' || n === 'TEXTAREA'; }
document.addEventListener('keydown', function(e){
  if (e.key === 'Enter' && typing(e)){
    var map = {login:'login', link:'link', newpin:'savepin', setup:'setup'};
    if (map[S.screen]) { A[map[S.screen]](); return; }
    if (e.target.id === 'runq') { A.runsearch(); return; }
    if (e.target.id === 'quickq') { A.mkquick(); return; }
    if (e.target.id === 'radiomsg') { A.rsend(); return; }
  }
  if ((e.key === 'f' || e.key === 'F') && !typing(e) && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey){
    if (S.screen === 'cad' && S.radio.open){ e.preventDefault(); txStart(); }
  }
});
document.addEventListener('keyup', function(e){ if (e.key === 'f' || e.key === 'F') txStop(); });
document.addEventListener('pointerdown', function(e){ if (e.target.closest && e.target.closest('#ptt')){ e.preventDefault(); txStart(); } });
document.addEventListener('pointerup', txStop);
document.addEventListener('pointercancel', txStop);
window.addEventListener('blur', txStop);
window.addEventListener('beforeinstallprompt', function(e){ e.preventDefault(); installEvt = e; if (S.screen === 'login') render(); });
if ('serviceWorker' in navigator) window.addEventListener('load', function(){ navigator.serviceWorker.register('/sw.js').catch(function(){}); });

/* ---------- start ---------- */
render();
rpc('view').then(function(){
  var why = new URLSearchParams(location.search).get('discord');
  if (why){ history.replaceState(null, '', '/'); toast(why === 'off' ? 'Discord login is not set up yet.' : 'Discord login did not finish. Try again.'); }
  if (V.setup) go('setup');
  else if (!V.me) go(V.discord ? 'link' : 'login');
  else if (V.me.mustChange) go('newpin');
  else { connect(); if (V.me.duty){ S.radio.sel = dept(V.me.duty.agency).ch; go('cad'); } else go('units'); }
}).catch(function(e){ $('#app').innerHTML = '<div class="center"><div class="loadbox"><h1 style="font-size:24px">Cannot reach the CAD server</h1><div class="muted">' + esc(e.message) + '</div><button type="button" class="btn primary" onclick="location.reload()">Try again</button></div></div>'; });
})();
