// Bach Chorale Explorer
// Ingests the 370 Bach chorales (Humdrum **kern) into an IndexedDB store,
// then searches them by text, melody (interval pattern) or harmony (Roman numerals).
// Scores are engraved with Verovio; playback uses Web Audio and MIDI export uses Verovio.

import createVerovioModule from "https://cdn.jsdelivr.net/npm/verovio@5.7.0/dist/verovio-module-hum.mjs";
import { VerovioToolkit } from "https://cdn.jsdelivr.net/npm/verovio@5.7.0/dist/verovio.mjs";

const DATA_URL = "data/chorales.krn";
const DATA_VERSION = "2026-10-19.2"; // bump to force re-ingestion after parser changes
const SOPRANO = 3; // spines are bass, tenor, alto, soprano

const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");

let chorales = [];          // parsed records, ordered by number
let byId = new Map();
let mode = "text";
let lastMatches = new Map(); // id -> { lines:Set, fields:[...], note:string }
let current = null;
let tk = null;

const verovioReady = createVerovioModule()
  .then((mod) => { tk = new VerovioToolkit(mod); return tk; })
  .catch((err) => { console.error(err); setStatus("Could not load the notation engine (Verovio). Check your connection."); });

/* ------------------------------------------------------------------ *
 *  Parsing **kern                                                     *
 * ------------------------------------------------------------------ */

const PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

function parsePitch(tok) {
  const m = tok.match(/([a-gA-G])\1*/);
  if (!m) return null;
  const letter = m[1];
  const n = m[0].length;
  const lower = letter === letter.toLowerCase();
  const octave = lower ? 3 + n : 4 - n; // c = C4 (MIDI 60), C = C3
  const rest = tok.slice(m.index + n);
  let acc = 0;
  const a = rest.match(/^(#+|-+)/);
  if (a) acc = a[1][0] === "#" ? a[1].length : -a[1].length;
  return (octave + 1) * 12 + PC[letter.toLowerCase()] + acc;
}

function parseDuration(tok) {
  const m = tok.match(/(\d+)(\.*)/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const base = n === 0 ? 8 : 4 / n; // in quarter notes
  const dots = m[2].length;
  return base * (2 - 1 / 2 ** dots);
}

const QUALITIES = [
  // [name, intervals above root, minimum bass requirement]
  ["7", [0, 4, 7, 10]],
  ["m7", [0, 3, 7, 10]],
  ["ø7", [0, 3, 6, 10]],
  ["o7", [0, 3, 6, 9]],
  ["M7", [0, 4, 7, 11]],
  ["M", [0, 4, 7]],
  ["m", [0, 3, 7]],
  ["o", [0, 3, 6]],
  ["7", [0, 4, 10]],          // dominant seventh without fifth
];
const INCOMPLETE = [["M", [0, 4]], ["m", [0, 3]]]; // only when the bass is the root

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  return a.every((x) => b.includes(x));
}

function identifyChord(notes) {
  const sounding = notes.filter((n) => n != null);
  if (sounding.length < 2) return null;
  const pcs = [...new Set(sounding.map((n) => ((n % 12) + 12) % 12))];
  const bassPc = ((Math.min(...sounding) % 12) + 12) % 12;
  // Prefer the reading where the bass is the root, then any root.
  const roots = [bassPc, ...pcs.filter((p) => p !== bassPc)];
  for (const [q, ivs] of QUALITIES) {
    for (const r of roots) {
      if (sameSet(pcs, ivs.map((i) => (r + i) % 12))) return { root: r, quality: q, bassPc };
    }
  }
  for (const [q, ivs] of INCOMPLETE) {
    if (sameSet(pcs, ivs.map((i) => (bassPc + i) % 12))) return { root: bassPc, quality: q, bassPc };
  }
  return null;
}

const NUMERALS_MAJOR = ["I", "bII", "II", "bIII", "III", "IV", "#IV", "V", "bVI", "VI", "bVII", "VII"];
const NUMERALS_MINOR = ["I", "bII", "II", "III", "#III", "IV", "#IV", "V", "VI", "#VI", "VII", "VII"];

function romanNumeral(chord, tonic, minor) {
  const deg = (chord.root - tonic + 12) % 12;
  let rn = (minor ? NUMERALS_MINOR : NUMERALS_MAJOR)[deg];
  const q = chord.quality;
  const upper = q === "M" || q === "7" || q === "M7";
  if (!upper) rn = rn.replace(/[IV]+/, (s) => s.toLowerCase());
  const suffix = { M: "", m: "", o: "°", "7": "7", m7: "7", "ø7": "ø7", o7: "°7", M7: "M7" }[q];
  return rn + suffix;
}

const entityBox = document.createElement("textarea");
function decodeEntities(s) {
  if (!s.includes("&")) return s;
  entityBox.innerHTML = s;
  return entityBox.value;
}

function parseChorale(id, kern) {
  const rec = { id, kern, num: 0, bwv: "", titleDE: "", titleEN: "", key: "", meter: "", melody: [], chords: [] };
  const lines = kern.split("\n");
  const ends = [0, 0, 0, 0];
  const sounding = [null, null, null, null];
  const slices = [];
  let time = 0;
  let measure = 1;
  let tonic = 0, minor = false;

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (line.startsWith("!!!")) {
      const m = line.match(/^!!!([^:]+):\s*(.*)$/);
      if (!m) return;
      const k = m[1], v = decodeEntities(m[2]);
      if (k === "OTL@@DE" || k === "OTL") rec.titleDE ||= v.trim();
      else if (k === "OTL@EN") rec.titleEN = v.trim();
      else if (k === "SCT") rec.bwv = v.trim();
      else if (k === "PC#") rec.num = parseInt(v, 10) || 0;
      return;
    }
    if (!line || line.startsWith("!") || line.startsWith("**")) return;
    const fields = line.split("\t");
    if (line.startsWith("*")) {
      const f = fields[0];
      const km = f.match(/^\*([A-Ga-g])([#-]?):$/);
      if (km && !rec.key) {
        minor = km[1] === km[1].toLowerCase();
        tonic = (PC[km[1].toLowerCase()] + (km[2] === "#" ? 1 : km[2] === "-" ? -1 : 0) + 12) % 12;
        rec.key = km[1].toUpperCase() + (km[2] === "#" ? "♯" : km[2] === "-" ? "♭" : "") + (minor ? " minor" : " major");
      }
      const mm = f.match(/^\*M(\d+\/\d+)$/);
      if (mm && !rec.meter) rec.meter = mm[1];
      return;
    }
    if (line.startsWith("=")) {
      const bm = line.match(/^=(\d+)/);
      if (bm) measure = parseInt(bm[1], 10);
      return;
    }
    // Data line
    let attack = false;
    for (let v = 0; v < 4; v++) {
      const tok = fields[v];
      if (tok == null || tok === ".") continue;
      if (tok.includes("q")) continue; // grace note
      ends[v] = time + parseDuration(tok);
      if (tok.includes("r")) { sounding[v] = null; continue; }
      const midi = parsePitch(tok);
      sounding[v] = midi;
      const tieContinuation = tok.includes("]") || tok.includes("_");
      if (!tieContinuation) {
        attack = true;
        if (v === SOPRANO) rec.melody.push({ midi, line: lineNo, measure });
      }
    }
    if (attack) slices.push({ line: lineNo, measure, time, notes: sounding.slice() });
    const future = ends.filter((e) => e > time);
    const next = future.length ? Math.min(...future) : time;
    if (slices.length && slices[slices.length - 1].time === time) slices[slices.length - 1].dur = next - time;
    time = next;
  });

  // Harmony: label each vertical sonority, skipping non-chord sonorities and very short ones.
  let prev = null;
  for (const s of slices) {
    if ((s.dur ?? 1) < 0.5) continue;
    const chord = identifyChord(s.notes);
    if (!chord) continue;
    const label = romanNumeral(chord, tonic, minor);
    if (prev && prev.label === label) { prev.lines.push(s.line); continue; }
    prev = { label, measure: s.measure, line: s.line, lines: [s.line] };
    rec.chords.push(prev);
  }
  return rec;
}

/* ------------------------------------------------------------------ *
 *  Data store (IndexedDB)                                             *
 * ------------------------------------------------------------------ */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("bach-chorale-explorer", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("chorales", { keyPath: "id" });
      db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqResult(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function ingest(db) {
  setStatus("Ingesting the chorale encodings into the local database…");
  const text = await fetch(DATA_URL).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });
  const segments = text.split(/(?=^!!!!SEGMENT:)/m).filter((s) => s.startsWith("!!!!SEGMENT"));
  const records = segments.map((seg) => {
    const id = seg.match(/^!!!!SEGMENT:\s*(\S+?)\.krn/)[1];
    return parseChorale(id, seg.replace(/\n+$/, ""));
  });
  if (db) {
    const tx = db.transaction(["chorales", "meta"], "readwrite");
    const store = tx.objectStore("chorales");
    store.clear();
    records.forEach((r) => store.put(r));
    tx.objectStore("meta").put({ version: DATA_VERSION, ingestedAt: new Date().toISOString(), count: records.length }, "info");
    await txDone(tx);
  }
  return records;
}

async function loadCorpus(force = false) {
  let db = null;
  try { db = await openDB(); } catch (e) { console.warn("IndexedDB unavailable; using memory only", e); }
  let records = null;
  let info = null;
  if (db && !force) {
    try {
      const tx = db.transaction(["chorales", "meta"], "readonly");
      info = await reqResult(tx.objectStore("meta").get("info"));
      if (info && info.version === DATA_VERSION) records = await reqResult(tx.objectStore("chorales").getAll());
    } catch (e) { console.warn(e); }
  }
  let fresh = false;
  if (!records || !records.length) {
    records = await ingest(db);
    fresh = true;
  }
  records.sort((a, b) => a.num - b.num);
  chorales = records;
  byId = new Map(records.map((r) => [r.id, r]));
  const where = db ? "local IndexedDB store" : "memory";
  setStatus(
    `${records.length} chorales ${fresh ? "ingested into" : "loaded from"} the ${where}. `,
    db ? { label: "Re-ingest", onClick: () => loadCorpus(true).then(runSearch) } : null
  );
}

function setStatus(text, action) {
  statusEl.textContent = text;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.style.cssText = "font-size:0.8rem;padding:0 8px;margin-left:4px";
    b.onclick = action.onClick;
    statusEl.append(b);
  }
}

/* ------------------------------------------------------------------ *
 *  Search                                                             *
 * ------------------------------------------------------------------ */

const MODES = {
  text: {
    placeholder: "Title, BWV, or number",
    hint: "Search German or English titles, a BWV number, or the chorale number.",
    examples: ["Jesu", "Herz", "Gott", "BWV 269", "Christ"],
  },
  melody: {
    placeholder: "e.g.  G A B C   or   +2 +2 +1",
    hint: "Soprano melody, at any transposition. Type note names (<code>C D E</code>, <code>F# G</code>, <code>Bb A</code>) or semitone steps (<code>+2 -1 -2</code>).",
    examples: ["G A B C", "C B A G F E D C", "+2 +2 +1", "D D A A B B A", "-1 -2 -2 -1"],
  },
  harmony: {
    placeholder: "e.g.  ii V7 I",
    hint: "Roman numerals relative to the home key. Case matters (<code>ii</code> minor, <code>II</code> major); use <code>°</code> or <code>o</code> for diminished. <code>V</code> also matches <code>V7</code>.",
    examples: ["IV V I", "ii V7 I", "V vi", "vii°7 i", "I IV I"],
  },
};

const NOTE_RE = /^([A-Ga-g])(#{1,2}|♯|b{1,2}|♭|-{1,2})?$/;

function noteToPc(tok) {
  const m = tok.match(NOTE_RE);
  let pc = PC[m[1].toLowerCase()];
  const acc = m[2] || "";
  if (acc.startsWith("#") || acc === "♯") pc += acc === "♯" ? 1 : acc.length;
  else if (acc) pc -= acc === "♭" ? 1 : acc.length;
  return (pc + 12) % 12;
}

function parseMelodyQuery(q) {
  const toks = q.trim().split(/[\s,]+/).filter(Boolean);
  if (!toks.length) return null;
  if (toks.every((t) => /^[+-]?\d+$/.test(t))) return toks.map(Number);
  if (toks.every((t) => NOTE_RE.test(t))) {
    if (toks.length < 2) return null;
    const pcs = toks.map(noteToPc);
    const ivs = [];
    for (let i = 1; i < pcs.length; i++) {
      let d = (pcs[i] - pcs[i - 1] + 12) % 12;
      if (d > 6) d -= 12;
      ivs.push(d);
    }
    return ivs;
  }
  return undefined; // malformed
}

function normalizeNumeral(s) {
  return s.replace(/o/g, "°").replace(/[øh%]/g, "ø").replace(/♭/g, "b").replace(/♯/g, "#");
}

function chordMatches(qTok, label) {
  if (qTok === label) return true;
  return !qTok.includes("7") && label.replace(/7$/, "") === qTok;
}

function fold(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function search(q) {
  const matches = new Map();
  const query = q.trim();
  if (!query) {
    chorales.forEach((c) => matches.set(c.id, null));
    return { matches };
  }

  if (mode === "text") {
    const num = query.match(/^(?:bwv\s*)?(\d+(?:\.\d+)?)$/i);
    const f = fold(query);
    for (const c of chorales) {
      let ok = false;
      if (num) {
        const n = num[1];
        if (/^bwv/i.test(query)) ok = new RegExp(`\\b${n.replace(".", "\\.")}\\b`).test(c.bwv);
        else ok = String(c.num) === n || new RegExp(`\\b${n.replace(".", "\\.")}\\b`).test(c.bwv);
      } else {
        ok = fold(`${c.titleDE} ${c.titleEN} ${c.bwv}`).includes(f);
      }
      if (ok) matches.set(c.id, null);
    }
    return { matches };
  }

  if (mode === "melody") {
    const ivs = parseMelodyQuery(query);
    if (ivs === undefined) return { error: "Use note names like C D E or semitone steps like +2 -1." };
    if (!ivs || !ivs.length) return { error: "Enter at least two notes (or one interval)." };
    for (const c of chorales) {
      const mel = c.melody;
      const hits = [];
      for (let i = 0; i + ivs.length < mel.length; i++) {
        let ok = true;
        for (let k = 0; k < ivs.length; k++) {
          if (mel[i + k + 1].midi - mel[i + k].midi !== ivs[k]) { ok = false; break; }
        }
        if (ok) hits.push({ measure: mel[i].measure, lines: mel.slice(i, i + ivs.length + 1).map((n) => n.line) });
      }
      if (hits.length) matches.set(c.id, { kind: "melody", hits, fields: [SOPRANO + 1] });
    }
    return { matches };
  }

  // harmony
  const toks = query.split(/[\s,–-]+/).filter(Boolean).map(normalizeNumeral);
  if (!toks.length) return { error: "Enter one or more Roman numerals." };
  for (const c of chorales) {
    const ch = c.chords;
    const hits = [];
    for (let i = 0; i + toks.length <= ch.length; i++) {
      if (toks.every((t, k) => chordMatches(t, ch[i + k].label))) {
        hits.push({ measure: ch[i].measure, lines: ch.slice(i, i + toks.length).flatMap((x) => x.lines) });
      }
    }
    if (hits.length) matches.set(c.id, { kind: "harmony", hits, fields: [1, 2, 3, 4] });
  }
  return { matches };
}

function runSearch() {
  if (!chorales.length) return;
  const q = $("#q").value;
  const { matches, error } = search(q);
  const list = $("#results");
  list.textContent = "";
  if (error) {
    $("#result-count").textContent = error;
    lastMatches = new Map();
    return;
  }
  lastMatches = matches;
  const total = [...matches.values()].reduce((n, m) => n + (m ? m.hits.length : 0), 0);
  $("#result-count").textContent = q.trim()
    ? `${matches.size} chorale${matches.size === 1 ? "" : "s"}` + (total ? ` · ${total} occurrence${total === 1 ? "" : "s"}` : "")
    : `All ${matches.size} chorales`;

  const frag = document.createDocumentFragment();
  for (const id of matches.keys()) {
    const c = byId.get(id);
    const m = matches.get(id);
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#${id}`;
    if (current && current.id === id) a.setAttribute("aria-current", "true");
    a.innerHTML = `<span class="num">${c.num}</span><span class="t"></span><span class="meta"></span>`;
    a.querySelector(".t").textContent = c.titleDE;
    const where = m ? ` · m. ${[...new Set(m.hits.map((h) => h.measure))].slice(0, 6).join(", ")}` : "";
    a.querySelector(".meta").textContent = [c.bwv, c.key].filter(Boolean).join(" · ") + where;
    li.append(a);
    frag.append(li);
  }
  list.append(frag);
  if (current) highlightMatches();
}

/* ------------------------------------------------------------------ *
 *  Score display                                                      *
 * ------------------------------------------------------------------ */

async function openChorale(id) {
  const c = byId.get(id);
  if (!c) return;
  stopPlayback();
  current = c;
  $("#empty").hidden = true;
  $("#piece").hidden = false;
  $("#piece-title").textContent = `${c.num}. ${c.titleDE}`;
  $("#piece-sub").textContent = c.titleEN || "";
  $("#piece-meta").textContent = [c.bwv, c.key, c.meter && `${c.meter} time`].filter(Boolean).join(" · ");
  document.title = `${c.titleDE} · Bach Chorale Explorer`;
  $("#chords").innerHTML = renderChordStrip(c);
  document.querySelectorAll("#results a").forEach((a) => a.toggleAttribute("aria-current", a.getAttribute("href") === `#${id}`));
  document.querySelectorAll('#results a[aria-current]').forEach((a) => a.setAttribute("aria-current", "true"));

  $("#score").innerHTML = "<p class='hint'>Engraving…</p>";
  await verovioReady;
  if (!tk) return;
  renderScore();
  if (window.matchMedia("(max-width: 860px)").matches) $("#piece").scrollIntoView({ behavior: "smooth" });
}

function renderChordStrip(c) {
  let out = "";
  let m = null;
  for (const ch of c.chords) {
    if (ch.measure !== m) { if (m !== null) out += `<span class="bar">|</span> `; m = ch.measure; }
    out += `${ch.label} `;
  }
  return out;
}

function renderScore() {
  if (!current || !tk) return;
  const el = $("#score");
  const width = Math.max(320, el.clientWidth || 800);
  const scale = width < 600 ? 30 : 40;
  tk.setOptions({
    inputFrom: "humdrum",
    pageWidth: Math.round((width * 100) / scale),
    pageHeight: 60000,
    scale,
    adjustPageHeight: true,
    breaks: "auto",
    header: "none",
    footer: "none",
    pageMarginTop: 40,
    pageMarginBottom: 40,
    pageMarginLeft: 30,
    pageMarginRight: 30,
  });
  tk.loadData(current.kern);
  let svg = "";
  for (let p = 1; p <= tk.getPageCount(); p++) svg += tk.renderToSVG(p);
  el.innerHTML = svg;
  highlightMatches();
}

function highlightMatches() {
  const el = $("#score");
  el.querySelectorAll("g.note.match").forEach((n) => n.classList.remove("match"));
  const note = $("#match-note");
  const m = current && lastMatches.get(current.id);
  if (!m) { note.textContent = ""; return; }
  let first = null;
  for (const h of m.hits) {
    for (const line of h.lines) {
      for (const f of m.fields) {
        el.querySelectorAll(`[id^="note-L${line}F${f}"]`).forEach((n) => {
          n.classList.add("match");
          first ||= n;
        });
      }
    }
  }
  const measures = [...new Set(m.hits.map((h) => h.measure))];
  note.textContent = `${m.hits.length} match${m.hits.length === 1 ? "" : "es"} (${m.kind}) in m. ${measures.join(", ")}, shown in red.`;
}

/* ------------------------------------------------------------------ *
 *  Playback (Web Audio) and MIDI export                               *
 * ------------------------------------------------------------------ */

let audio = null;
let playing = null; // { nodes, timers }

function voice(ctx, dest, midi, start, dur) {
  const f = 440 * 2 ** ((midi - 69) / 12);
  const g = ctx.createGain();
  const end = start + Math.max(0.05, dur);
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(0.11, start + 0.03);
  g.gain.setValueAtTime(0.11, Math.max(start + 0.03, end - 0.06));
  g.gain.linearRampToValueAtTime(0, end);
  g.connect(dest);
  const nodes = [g];
  // A soft reed-organ tone: fundamental plus a few quiet partials.
  [[1, 1], [2, 0.35], [3, 0.14], [4, 0.06]].forEach(([mult, amp]) => {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = f * mult;
    const og = ctx.createGain();
    og.gain.value = amp;
    o.connect(og).connect(g);
    o.start(start);
    o.stop(end + 0.02);
    nodes.push(o);
  });
  return nodes;
}

function stopPlayback() {
  if (!playing) return;
  playing.timers.forEach(clearTimeout);
  playing.nodes.forEach((n) => { try { n.stop ? n.stop() : n.disconnect(); } catch {} });
  playing.master.disconnect();
  playing = null;
  document.querySelectorAll("#score g.note.playing").forEach((n) => n.classList.remove("playing"));
  $("#play").textContent = "▶ Play";
}

async function play() {
  if (playing) { stopPlayback(); return; }
  if (!tk || !current) return;
  audio ||= new (window.AudioContext || window.webkitAudioContext)();
  await audio.resume();
  const master = audio.createGain();
  master.gain.value = 0.8;
  master.connect(audio.destination);
  const timemap = tk.renderToTimemap({ includeMeasures: false, includeRests: false });
  const t0 = audio.currentTime + 0.15;
  const nodes = [];
  const timers = [];
  const score = $("#score");
  let endMs = 0;
  for (const ev of timemap) {
    for (const id of ev.on || []) {
      const v = tk.getMIDIValuesForElement(id);
      if (!v || !(v.pitch > 0)) continue;
      nodes.push(...voice(audio, master, v.pitch, t0 + v.time / 1000, v.duration / 1000));
      endMs = Math.max(endMs, v.time + v.duration);
    }
    timers.push(setTimeout(() => {
      (ev.off || []).forEach((id) => score.querySelector(`#${CSS.escape(id)}`)?.classList.remove("playing"));
      (ev.on || []).forEach((id) => score.querySelector(`#${CSS.escape(id)}`)?.classList.add("playing"));
    }, 150 + ev.tstamp));
  }
  timers.push(setTimeout(stopPlayback, 150 + endMs + 300));
  playing = { nodes, timers, master };
  $("#play").textContent = "■ Stop";
}

function downloadMidi() {
  if (!tk || !current) return;
  const b64 = tk.renderToMIDI();
  const a = document.createElement("a");
  a.href = `data:audio/midi;base64,${b64}`;
  a.download = `${current.id}.mid`;
  document.body.append(a);
  a.click();
  a.remove();
}

/* ------------------------------------------------------------------ *
 *  Wiring                                                             *
 * ------------------------------------------------------------------ */

function setMode(m) {
  mode = m;
  document.querySelectorAll(".modes button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === m)));
  const cfg = MODES[m];
  $("#q").placeholder = cfg.placeholder;
  $("#hint").innerHTML = cfg.hint;
  const ex = $("#examples");
  ex.textContent = "";
  cfg.examples.forEach((e) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = e;
    b.onclick = () => { $("#q").value = e; runSearch(); };
    ex.append(b);
  });
  $("#q").value = "";
  runSearch();
}

document.querySelectorAll(".modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$("#search-form").addEventListener("submit", (e) => { e.preventDefault(); runSearch(); });
$("#play").addEventListener("click", play);
$("#midi").addEventListener("click", downloadMidi);

function route() {
  const id = location.hash.slice(1);
  if (byId.has(id)) openChorale(id);
}
window.addEventListener("hashchange", route);

let resizeTimer;
let lastWidth = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const w = $("#score").clientWidth;
    if (Math.abs(w - lastWidth) > 40) { lastWidth = w; stopPlayback(); renderScore(); }
  }, 250);
});

setMode("text");
loadCorpus()
  .then(() => { runSearch(); route(); })
  .catch((err) => { console.error(err); setStatus(`Could not load the chorales: ${err.message}`); });
