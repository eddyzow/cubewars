// arenaReplay.js — Cube Wars replay recording + playback. Pure logic.
//
// A replay is NOT frame data: the engine is deterministic given a seed and the
// per-tick inputs, so a replay is just (seed, inputs). Re-running the sim
// reproduces the match bit-for-bit — every shot, item spawn, and knockback.
// That keeps a full match in the KILOBYTES instead of megabytes.
//
// Wire/text format v2 (line-based, downloads cleanly as .txt):
//   CUBEWARS-REPLAY v2
//   {json meta}
//   [+tickGap36 ]field0 field1
//
//   field := "."                       player's input unchanged
//          | [mask36] "," [aimDelta36] either part may be empty
//
// A frame line is emitted only when either player's input CHANGED; unchanged
// ticks repeat the previous inputs (the server's "latest input wins" model
// means inputs naturally persist between updates). The leading "+gap" token
// is omitted when the line lands one tick after the previous one — the
// overwhelmingly common case while the mouse is moving.
//
// mask is the 9 button bits, base36. aim is stored as a fixed-point integer
// (radians * 1e4) and encoded as a signed base36 DELTA from the previous
// stored value — mouse movement between adjacent ticks is tiny, so deltas are
// 1-2 chars where v1 spent ~18 on an absolute decimal. A typical mouse-move
// tick is ",k ." (5 bytes) vs v1's "1 197,1.5707963267948966 ." (~26).
//
// IMPORTANT: playback is only exact if the inputs recorded here are the exact
// values fed to game.step(). Aim is quantized to 1e-4 rad at the input source
// (controller + server sanitizeInput), so round(aim*1e4) is lossless and
// ai/1e4 reproduces the identical float64 on decode.

(function (root) {
  "use strict";

  const VERSION = 2;
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

  // ---- recording (server side) ---------------------------------------------

  class Recorder {
    constructor(seed) {
      this.seed = seed;
      this.lines = [];
      this.prev = [{ mask: 0, ai: 0 }, { mask: 0, ai: 0 }];
      this.lastEmittedTick = 0;
      this.ticks = 0;
      this.rounds = [0]; // tick each round starts at (round 1 = tick 0)
    }

    // Call once per game.step with the tick it produced and the inputs fed.
    record(tick, inp0, inp1) {
      this.ticks = tick;
      const fields = [inp0, inp1].map((inp, i) => {
        const p = this.prev[i];
        const mask = maskOf(inp);
        const ai = Math.round(inp.aim * 1e4);
        let s = (mask !== p.mask ? mask.toString(36) : "") + ",";
        if (ai !== p.ai) s += (ai - p.ai).toString(36);
        p.mask = mask;
        p.ai = ai;
        return s === "," ? "." : s;
      });
      if (fields[0] === "." && fields[1] === ".") return;
      const gap = tick - this.lastEmittedTick;
      this.lines.push(
        (gap === 1 ? "" : "+" + gap.toString(36) + " ") + fields[0] + " " + fields[1]
      );
      this.lastEmittedTick = tick;
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
      return MAGIC + " v" + VERSION + "\n" + JSON.stringify(m) + "\n" + this.lines.join("\n") + "\n";
    }
  }

  // ---- playback ------------------------------------------------------------

  // Returns { meta, changes } where changes is [absoluteTick, inp0|null, inp1|null]
  // with fully materialized input objects. Handles v1 and v2 files.
  function decode(text) {
    const lines = String(text).split("\n");
    if (!lines[0] || lines[0].indexOf(MAGIC) !== 0) {
      throw new Error("Not a Cube Wars replay file.");
    }
    const meta = JSON.parse(lines[1]);
    if (meta.v !== 1 && meta.v !== VERSION) {
      throw new Error("Replay version " + meta.v + " is not supported by this client.");
    }
    const changes = [];
    let t = 0;

    if (meta.v === 1) {
      // v1: "<gap> <mask36,aimDecimal|.> <...>" with absolute aim values.
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
      return { meta: meta, changes: changes };
    }

    // v2: delta-encoded. Decoder tracks each player's running (mask, ai).
    const st = [{ mask: 0, ai: 0 }, { mask: 0, ai: 0 }];
    const parseField = (s, p) => {
      if (s === ".") return null;
      const c = s.indexOf(",");
      const maskStr = s.slice(0, c);
      const deltaStr = s.slice(c + 1);
      if (maskStr) p.mask = parseInt(maskStr, 36);
      if (deltaStr) p.ai += parseInt(deltaStr, 36);
      return inputFrom(p.mask, p.ai / 1e4);
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
    return { meta: meta, changes: changes };
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
