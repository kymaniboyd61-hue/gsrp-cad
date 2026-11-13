// Small pure helpers, kept apart so they can be tested without Discord.

// 48 kHz mono 16-bit PCM -> 16 kHz (averages each group of three samples).
export function downsample48to16(pcm) {
  const inSamples = Math.floor(pcm.length / 2), outSamples = Math.floor(inSamples / 3);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const a = pcm.readInt16LE(i * 6), b = pcm.readInt16LE(i * 6 + 2), c = pcm.readInt16LE(i * 6 + 4);
    out.writeInt16LE(Math.round((a + b + c) / 3), i * 2);
  }
  return out;
}

// Wrap raw mono 16-bit PCM in a WAV header.
export function wavFromPcm(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Did they call the dispatcher, and what did they say after the wake word?
// Speech-to-text often hears "dispatch" as "dispatched" or "this patch", so a few near misses count.
export function parseWake(text, wake) {
  const t = String(text || "").trim();
  const w = String(wake || "dispatch").toLowerCase().replace(/[^a-z]/g, "");
  const variants = w === "dispatch" ? "dispatch(?:ed|er|es)?|this patch|dis patch" : w;
  const m = t.match(new RegExp("\\b(?:" + variants + ")\\b[\\s,.!?:;-]*", "i"));
  if (!m) return { called: false, rest: t };
  const rest = (t.slice(0, m.index) + " " + t.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  return { called: true, rest: rest.replace(/^[,.\s]+/, "") };
}

// Make the model's answer safe to read aloud: no markdown, one short paragraph.
export function cleanReply(text) {
  return String(text || "").replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim().slice(0, 400);
}
