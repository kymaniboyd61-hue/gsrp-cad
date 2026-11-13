// GSRP voice dispatcher. Sits in one Discord voice channel, listens for the wake word,
// asks an AI model for the answer, speaks it, and keeps the CAD in step.
import { Client, GatewayIntentBits, Events } from "discord.js";
import { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, EndBehaviorType, VoiceConnectionStatus, AudioPlayerStatus } from "@discordjs/voice";
import prism from "prism-media";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { downsample48to16, wavFromPcm, parseWake, cleanReply } from "./lib.js";

const E = process.env;
const need = ["DISCORD_TOKEN", "GUILD_ID", "VOICE_CHANNEL_ID", "CAD_URL", "CAD_BOT_KEY", "GROQ_API_KEY"].filter((k) => !E[k]);
if (need.length) { console.error("Missing settings in the .env file: " + need.join(", ")); process.exit(1); }
const WAKE = E.WAKE_WORD || "dispatch";
const STT_MODEL = E.STT_MODEL || "whisper-large-v3-turbo";
const CHAT_MODEL = E.CHAT_MODEL || "openai/gpt-oss-120b";
const CAD_URL = E.CAD_URL.replace(/\/+$/, "");
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

/* ---------- CAD ---------- */
async function cad(op, a) {
  try {
    const r = await fetch(CAD_URL + "/api/bot", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + E.CAD_BOT_KEY }, body: JSON.stringify({ op, a: a || {} }), signal: AbortSignal.timeout(8000) });
    if (r.status === 401) return { ok: false, error: "The CAD refused the bot key. Create a new one in Admin > Discord and put it in .env." };
    return await r.json();
  } catch (e) { return { ok: false, error: "Could not reach the CAD." }; }
}
let enabled = false, lastState = null;
async function refreshState() {
  const s = await cad("state");
  if (!s.ok) { if (enabled !== false) log("CAD problem:", s.error); enabled = false; return; }
  if (s.enabled !== enabled) log(s.enabled ? "Discord dispatch is ON in the CAD. Listening." : "Discord dispatch is OFF in the CAD. Staying quiet.");
  enabled = s.enabled; lastState = s;
}

/* ---------- Groq: speech to text, and the AI ---------- */
let pauseUntil = 0;
async function groq(path, init) {
  if (Date.now() < pauseUntil) throw new Error("paused");
  const r = await fetch("https://api.groq.com/openai/v1" + path, Object.assign({ signal: AbortSignal.timeout(20000) }, init, { headers: Object.assign({ authorization: "Bearer " + E.GROQ_API_KEY }, init.headers) }));
  if (r.status === 429) { pauseUntil = Date.now() + 60000; log("Groq free limit reached. Pausing for a minute."); throw new Error("rate limited"); }
  if (!r.ok) { const t = await r.text(); throw new Error("Groq said " + r.status + ": " + t.slice(0, 200)); }
  return r.json();
}
async function transcribe(wav) {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
  form.append("model", STT_MODEL); form.append("language", "en"); form.append("response_format", "json");
  form.append("prompt", "Police, fire and EMS radio traffic. Dispatch, 10-8, 10-6, 10-97, 10-23, 10-7, Code 3, postal, plate, traffic stop.");
  return String((await groq("/audio/transcriptions", { method: "POST", body: form })).text || "").trim();
}
const TOOLS = [
  ["run_plate", "Look up a vehicle plate in the CAD records.", { plate: { type: "string" } }, ["plate"], (a) => cad("plate", { plate: a.plate })],
  ["run_name", "Look up a civilian by full character name in the CAD records.", { name: { type: "string" } }, ["name"], (a) => cad("name", { name: a.name })],
  ["set_unit_status", "Set the calling unit's status on the CAD.", { status: { type: "string", enum: ["Available", "Busy", "En route", "On scene", "Unavailable"] } }, ["status"], (a, id) => cad("status", { discordId: id, status: a.status })],
  ["create_call", "Create a call on the CAD and attach the calling unit, for example a traffic stop.", { title: { type: "string" }, type: { type: "string" }, postal: { type: "string" }, priority: { type: "string", enum: ["Low", "Medium", "High"] } }, ["title", "type"], (a, id) => cad("createcall", Object.assign({ discordId: id }, a))],
  ["clear_active_call", "Close the calling unit's active call and show them Available.", {}, [], (a, id) => cad("clear", { discordId: id })],
  ["attach_to_pending_call", "Attach the calling unit to the oldest call that is holding.", {}, [], (a, id) => cad("getcall", { discordId: id })],
].map(([name, description, properties, required, run]) => ({ run, def: { type: "function", function: { name, description, parameters: { type: "object", properties, required } } } }));
const history = [];
async function think(userId, speaker, who, text) {
  const system = "You are the radio dispatcher for Georgia State Roleplay, a Roblox ER:LC roleplay game server. Everything is fictional game roleplay. " +
    "Your reply is spoken aloud in a Discord voice channel, so answer in one or two short plain sentences with no lists, symbols or markdown, in a calm professional radio style. " +
    "Start with the unit's callsign when you know it. You dispatch for every department: sheriff, state patrol, police, fire, EMS and DOT. " +
    "Use the tools when a unit asks you to run a plate or name, reports a status (10-8 Available, 10-6 Busy, 10-97 En route, 10-23 On scene, 10-7 Unavailable), starts a traffic stop or another call, asks for a call, or clears. " +
    "Only report record details that a tool returned. If a tool says there is no record, say so. If a tool fails because the speaker is not linked or not on duty, tell them to sign in to the CAD and go on duty. " +
    "You may also answer general questions briefly. The speech-to-text can mishear, so if the message makes no sense, ask them to repeat.";
  const context = "Speaker: " + speaker + ". CAD record for the speaker: " + JSON.stringify(who) + ". Units on duty: " + JSON.stringify((lastState && lastState.units) || []) + ". Calls holding: " + JSON.stringify((lastState && lastState.pendingCalls) || []) + ".";
  const messages = [{ role: "system", content: system }, { role: "system", content: context }].concat(history.slice(-8), [{ role: "user", content: speaker + " says: " + text }]);
  for (let round = 0; round < 4; round++) {
    const res = await groq("/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: CHAT_MODEL, messages, tools: TOOLS.map((t) => t.def), tool_choice: "auto", temperature: 0.4, max_tokens: 300 }) });
    const msg = res.choices && res.choices[0] && res.choices[0].message;
    if (!msg) break;
    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        const tool = TOOLS.find((t) => t.def.function.name === call.function.name);
        let args = {}; try { args = JSON.parse(call.function.arguments || "{}"); } catch (e) {}
        const out = tool ? await tool.run(args, userId) : { ok: false, error: "Unknown tool." };
        log("  tool", call.function.name, JSON.stringify(args), "->", JSON.stringify(out).slice(0, 160));
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out) });
      }
      continue;
    }
    const reply = cleanReply(msg.content);
    if (reply) { history.push({ role: "user", content: speaker + " says: " + text }, { role: "assistant", content: reply }); if (history.length > 16) history.splice(0, history.length - 16); }
    return reply;
  }
  return "";
}

/* ---------- voice out (free, built into the computer) ---------- */
function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let err = ""; p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject); p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(0, 200) || cmd + " failed"))));
    if (input != null) p.stdin.end(input); else p.stdin.end();
  });
}
async function synth(text) {
  const out = join(tmpdir(), "gsrp-dispatch-" + Date.now() + (process.platform === "darwin" ? ".aiff" : ".wav"));
  if (process.platform === "win32") {
    const ps = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 1; $s.SetOutputToWaveFile($env:GSRP_OUT); $s.Speak([Console]::In.ReadToEnd()); $s.Dispose()";
    process.env.GSRP_OUT = out;
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], text);
  } else if (process.platform === "darwin") await run("say", ["-o", out, text]);
  else await run("espeak-ng", ["-w", out, text]);
  return out;
}
const player = createAudioPlayer();
player.on("error", (e) => log("Audio problem:", e.message));
async function speak(text) {
  let file;
  try {
    file = await synth(text);
    player.play(createAudioResource(file));
    await entersState(player, AudioPlayerStatus.Playing, 5000);
    await entersState(player, AudioPlayerStatus.Idle, 60000);
  } catch (e) { log("Could not speak:", e.message); }
  if (file) unlink(file).catch(() => {});
}

/* ---------- voice in ---------- */
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const capturing = new Set(), armed = new Map();
let queue = Promise.resolve();
function capture(receiver, guild, userId) {
  if (userId === client.user.id || capturing.has(userId) || !enabled) return;
  capturing.add(userId);
  const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 800 } });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 });
  const chunks = []; let bytes = 0;
  const done = () => {
    if (!capturing.delete(userId)) return;
    const pcm = Buffer.concat(chunks), seconds = pcm.length / 96000;
    if (seconds < 0.5 || seconds > 25) return;
    queue = queue.then(() => handle(guild, userId, pcm)).catch((e) => log("Problem:", e.message));
  };
  decoder.on("data", (c) => { chunks.push(c); bytes += c.length; if (bytes > 96000 * 20) opus.destroy(); });
  decoder.on("end", done); decoder.on("error", done); opus.on("error", done); opus.on("close", () => decoder.end());
  opus.pipe(decoder);
}
async function handle(guild, userId, pcm) {
  if (!enabled || Date.now() < pauseUntil) return;
  const heard = await transcribe(wavFromPcm(downsample48to16(pcm), 16000));
  if (!heard) return;
  const wake = parseWake(heard, WAKE), isArmed = (armed.get(userId) || 0) > Date.now();
  if (!wake.called && !isArmed) return;
  armed.delete(userId);
  const member = await guild.members.fetch(userId).catch(() => null);
  const speaker = member ? member.displayName : "Unknown unit";
  const said = wake.called ? wake.rest : heard;
  log(speaker + ":", heard);
  if (said.replace(/[^a-z0-9]/gi, "").length < 3) { armed.set(userId, Date.now() + 12000); await speak("Go ahead."); return; }
  const who = await cad("who", { discordId: userId });
  await refreshState();
  if (!enabled) return;
  const reply = (await think(userId, who.unit || speaker, who, said)) || "Unit calling, say again.";
  log("DISPATCH:", reply);
  cad("log", { discordId: userId, speaker, heard: said, reply });
  await speak(reply);
}

/* ---------- start ---------- */
async function joinChannel() {
  const guild = await client.guilds.fetch(E.GUILD_ID);
  const channel = await guild.channels.fetch(E.VOICE_CHANNEL_ID);
  if (!channel || !channel.isVoiceBased()) throw new Error("VOICE_CHANNEL_ID is not a voice channel.");
  const conn = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
  conn.subscribe(player);
  conn.receiver.speaking.on("start", (userId) => capture(conn.receiver, guild, userId));
  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try { await Promise.race([entersState(conn, VoiceConnectionStatus.Signalling, 5000), entersState(conn, VoiceConnectionStatus.Connecting, 5000)]); }
    catch (e) { log("Lost the voice channel. Rejoining in 5 seconds."); try { conn.destroy(); } catch (x) {} setTimeout(() => joinChannel().catch((err) => log("Rejoin failed:", err.message)), 5000); }
  });
  await entersState(conn, VoiceConnectionStatus.Ready, 30000);
  log('In voice channel "' + channel.name + '". Say "' + WAKE + '" to call the dispatcher.');
}
client.once(Events.ClientReady, async () => {
  log("Logged in to Discord as " + client.user.tag);
  await refreshState();
  setInterval(refreshState, 15000);
  try { await joinChannel(); }
  catch (e) { log("Could not join the voice channel:", e.message, "- check the IDs in .env and that the bot has Connect and Speak permission."); }
});
process.on("unhandledRejection", (e) => log("Problem:", e && e.message ? e.message : e));
client.login(E.DISCORD_TOKEN).catch((e) => { console.error("Discord refused the bot token. Check DISCORD_TOKEN in .env. (" + e.message + ")"); process.exit(1); });
