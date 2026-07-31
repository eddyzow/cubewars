// arenaReplay.js — Cube Wars replay recording + playback. Pure logic.
//
// A replay is NOT frame data: the engine is deterministic given a seed and the
// per-tick inputs, so a replay is just (seed, inputs). Re-running the sim
// reproduces the match bit-for-bit — every shot, item spawn, and knockback.
//
// Format v4 (current):
//   CUBEWARS-REPLAY v4
//   {json meta}
//   <p0 aim stream>
//   <p0 mask stream>
//   <p1 aim stream>
//   <p1 mask stream>
//
// Each stream is a continuous run of BASE64 VARINTS with zero separators:
// every character carries 5 payload bits plus a continuation bit, so small
// numbers are exactly one character. Streams are (gap, value) pairs:
//   aim stream:  gap = ticks since this player's previous aim record,
//                value = zigzag(delta of round(aim*625)) — the direction-grid
//                index delta. Mouse micro-jitter below the grid emits nothing.
//   mask stream: gap as above, value = the absolute 9-bit button mask.
// A typical aim record is 2 characters where v1 spent ~26 per tick.
//
// The input source (controller + server sanitizeInput) quantizes aim to the
// 1/625-radian grid and samples it at 8Hz with a forced refresh on the tick
// an attack/dash is pressed — so the recorded values ARE the values the sims
// consumed, and round(aim*625) / 625 round-trips to the identical float64.
// That is what keeps playback exact.
//
// v1 (absolute decimal aim), v2 (1e-4 fixed-point deltas), and v3 (grid-index
// deltas, line grammar) remain decodable.

(function (root) {
  "use strict";

  const VERSION = 4;
  const AIM_DENOM = 625; // direction grid: ~3,900 directions
  const MAGIC = "CUBEWARS-REPLAY";

  const BITS = ["up", "down", "left", "right", "shoot", "melee", "dash", "useItem", "dropItem"];

  function maskOf(inp) {
    let mask = 0;
    for (let i = 0; i < BITS.length; i++) if (inp[BITS[i]]) mask |= 1 << i;
    return mask;
  }

  function inputFrom(mask, aim) {
    const inp = {
      up: false, down: false, left: false, right: false,
      shoot: false, melee: false, dash: false, useItem: false, dropItem: false,
      aim: aim,
    };
    for (let i = 0; i < BITS.length; i++) if (mask & (1 << i)) inp[BITS[i]] = true;
    return inp;
  }

  // ---- base64 varints ------------------------------------------------------

  const AB = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
  const AB_IDX = {};
  for (let i = 0; i < AB.length; i++) AB_IDX[AB[i]] = i;

  // Unsigned varint: little-endian 5-bit groups, bit 5 = "more chars follow".
  function vEnc(n) {
    let s = "";
    do {
      const payload = n % 32;
      n = Math.floor(n / 32);
      s += AB[(n > 0 ? 32 : 0) | payload];
    } while (n > 0);
    return s;
  }

  function vDecodeAll(str) {
    const out = [];
    let cur = 0;
    let mult = 1;
    for (let i = 0; i < str.length; i++) {
      const v = AB_IDX[str[i]];
      if (v === undefined) continue; // tolerate stray whitespace
      cur += (v & 31) * mult;
      if (v & 32) {
        mult *= 32;
      } else {
        out.push(cur);
        cur = 0;
        mult = 1;
      }
    }
    return out;
  }

  // Zigzag: signed -> unsigned with small magnitudes staying small.
  function zz(n) {
    return n >= 0 ? n * 2 : -n * 2 - 1;
  }
  function unzz(z) {
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }

  // ---- recording (server side) ---------------------------------------------

  class Recorder {
    constructor(seed) {
      this.seed = seed;
      // Event arrays per player: aim = [gap, zzDelta, ...], mask = [gap, mask, ...]
      this.aimEv = [[], []];
      this.maskEv = [[], []];
      this.prev = [
        { mask: 0, ai: 0, aimTick: 0, maskTick: 0 },
        { mask: 0, ai: 0, aimTick: 0, maskTick: 0 },
      ];
      this.ticks = 0;
      this.rounds = [0]; // tick each round starts at (round 1 = tick 0)
    }

    // Call once per game.step with the tick it produced and the inputs fed.
    record(tick, inp0, inp1) {
      this.ticks = tick;
      const inputs = [inp0, inp1];
      for (let i = 0; i < 2; i++) {
        const p = this.prev[i];
        const mask = maskOf(inputs[i]);
        const ai = Math.round(inputs[i].aim * AIM_DENOM);
        if (mask !== p.mask) {
          this.maskEv[i].push(tick - p.maskTick, mask);
          p.mask = mask;
          p.maskTick = tick;
        }
        if (ai !== p.ai) {
          this.aimEv[i].push(tick - p.aimTick, zz(ai - p.ai));
          p.ai = ai;
          p.aimTick = tick;
        }
      }
    }

    // Round markers for the viewer's "jump to round" control.
    noteEvents(tick, evs) {
      for (const e of evs) {
        if (e.type === "round_start") this.rounds.push(tick);
      }
    }

    encode(meta) {
      const m = Object.assign(
        { v: VERSION, seed: this.seed, ticks: this.ticks, rounds: this.rounds },
        meta || {}
      );
      const stream = (arr) => arr.map(vEnc).join("");
      return (
        MAGIC + " v" + VERSION + "\n" + JSON.stringify(m) + "\n" +
        stream(this.aimEv[0]) + "\n" + stream(this.maskEv[0]) + "\n" +
        stream(this.aimEv[1]) + "\n" + stream(this.maskEv[1]) + "\n"
      );
    }
  }

  // ---- playback ------------------------------------------------------------

  // Returns { meta, changes } where changes is [absoluteTick, inp0|null, inp1|null]
  // with fully materialized input objects, sorted by tick. Handles v1-v4.
  function decode(text) {
    const lines = String(text).split("\n");
    if (!lines[0] || lines[0].indexOf(MAGIC) !== 0) {
      throw new Error("Not a Cube Wars replay file.");
    }
    const meta = JSON.parse(lines[1]);
    if (meta.v === 1) return { meta: meta, changes: decodeV1(lines) };
    if (meta.v === 2 || meta.v === 3) return { meta: meta, changes: decodeV23(lines, meta.v) };
    if (meta.v === 4) return { meta: meta, changes: decodeV4(lines) };
    throw new Error("Replay version " + meta.v + " is not supported by this client.");
  }

  function decodeV4(lines) {
    // Rebuild the four event lists, merge into per-tick input changes.
    const events = []; // {t, p, kind, val}
    for (let p = 0; p < 2; p++) {
      const aim = vDecodeAll(lines[2 + p * 2] || "");
      const mask = vDecodeAll(lines[3 + p * 2] || "");
      let t = 0;
      for (let i = 0; i + 1 < aim.length; i += 2) {
        t += aim[i];
        events.push({ t: t, p: p, kind: 0, val: unzz(aim[i + 1]) });
      }
      t = 0;
      for (let i = 0; i + 1 < mask.length; i += 2) {
        t += mask[i];
        events.push({ t: t, p: p, kind: 1, val: mask[i + 1] });
      }
    }
    events.sort((a, b) => a.t - b.t);

    const st = [{ mask: 0, ai: 0 }, { mask: 0, ai: 0 }];
    const changes = [];
    let i = 0;
    while (i < events.length) {
      const t = events[i].t;
      const touched = [false, false];
      while (i < events.length && events[i].t === t) {
        const e = events[i++];
        if (e.kind === 0) st[e.p].ai += e.val;
        else st[e.p].mask = e.val;
        touched[e.p] = true;
      }
      changes.push([
        t,
        touched[0] ? inputFrom(st[0].mask, st[0].ai / AIM_DENOM) : null,
        touched[1] ? inputFrom(st[1].mask, st[1].ai / AIM_DENOM) : null,
      ]);
    }
    return changes;
  }

  function decodeV1(lines) {
    const changes = [];
    let t = 0;
    const unpackV1 = (part) => {
      const c = part.indexOf(",");
      return inputFrom(parseInt(part.slice(0, c), 36), Number(part.slice(c + 1)) || 0);
    };
    for (let i = 2; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (!ln) continue;
      const sp1 = ln.indexOf(" ");
      const sp2 = ln.indexOf(" ", sp1 + 1);
      t += parseInt(ln.slice(0, sp1), 10);
      const a = ln.slice(sp1 + 1, sp2);
      const b = ln.slice(sp2 + 1);
      changes.push([t, a === "." ? null : unpackV1(a), b === "." ? null : unpackV1(b)]);
    }
    return changes;
  }

  function decodeV23(lines, v) {
    const denom = v === 2 ? 1e4 : AIM_DENOM;
    const st = [{ mask: 0, ai: 0 }, { mask: 0, ai: 0 }];
    const changes = [];
    let t = 0;
    const parseField = (s, p) => {
      if (s === ".") return null;
      const c = s.indexOf(",");
      const maskStr = s.slice(0, c);
      const deltaStr = s.slice(c + 1);
      if (maskStr) p.mask = parseInt(maskStr, 36);
      if (deltaStr) p.ai += parseInt(deltaStr, 36);
      return inputFrom(p.mask, p.ai / denom);
    };
    for (let i = 2; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (!ln) continue;
      const toks = ln.split(" ");
      let f0, f1;
      if (toks[0][0] === "+") {
        t += parseInt(toks[0].slice(1), 36);
        f0 = toks[1];
        f1 = toks[2];
      } else {
        t += 1;
        f0 = toks[0];
        f1 = toks[1];
      }
      changes.push([t, parseField(f0, st[0]), parseField(f1, st[1])]);
    }
    return changes;
  }

  // Sequential input feed. inputsFor(tick) must be called with non-decreasing
  // ticks; call reset() before seeking backwards.
  class Cursor {
    constructor(decoded) {
      this.changes = decoded.changes;
      this.reset();
    }

    reset() {
      this.idx = 0;
      this.current = [inputFrom(0, 0), inputFrom(0, 0)];
    }

    inputsFor(tick) {
      while (this.idx < this.changes.length && this.changes[this.idx][0] <= tick) {
        const ch = this.changes[this.idx++];
        if (ch[1]) this.current[0] = ch[1];
        if (ch[2]) this.current[1] = ch[2];
      }
      return this.current;
    }
  }

  const api = { VERSION: VERSION, Recorder: Recorder, decode: decode, Cursor: Cursor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CubeArenaReplay = api;
})(typeof window !== "undefined" ? window : globalThis);
