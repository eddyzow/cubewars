// arenaReplay.js — Cube Wars replay recording + playback. Pure logic.
//
// A replay is NOT frame data: the engine is deterministic given a seed and the
// per-tick inputs, so a replay is just (seed, inputs). Re-running the sim
// reproduces the match bit-for-bit — every shot, item spawn, and knockback.
// That keeps a full match in the tens of kilobytes instead of megabytes.
//
// Wire/text format (line-based, downloads cleanly as .txt):
//   CUBEWARS-REPLAY v1
//   {json meta}
//   <tickGap> <p0part> <p1part>
//   ...
// A frame line is emitted only when either player's input CHANGED; unchanged
// ticks repeat the previous inputs (the server's "latest input wins" model
// means inputs naturally persist between updates). tickGap is the distance
// from the previously emitted line. A part is "mask,aim" (mask = button bits
// in base36, aim in radians) or "." when that player's input is unchanged.
//
// IMPORTANT: playback is only exact if the inputs recorded here are the exact
// values fed to game.step(). Aim is quantized to 1e-4 rad at the input source
// (controller + server sanitizeInput) so the values survive JSON round-trips
// and stay short in the encoding.

(function (root) {
  "use strict";

  const VERSION = 1;
  const MAGIC = "CUBEWARS-REPLAY";

  const BITS = ["up", "down", "left", "right", "shoot", "melee", "dash", "useItem", "dropItem"];

  function packInput(inp) {
    let mask = 0;
    for (let i = 0; i < BITS.length; i++) if (inp[BITS[i]]) mask |= 1 << i;
    return mask.toString(36) + "," + inp.aim;
  }

  function unpackInput(part) {
    const c = part.indexOf(",");
    const mask = parseInt(part.slice(0, c), 36);
    const inp = {
      up: false, down: false, left: false, right: false,
      shoot: false, melee: false, dash: false, useItem: false, dropItem: false,
      aim: Number(part.slice(c + 1)) || 0,
    };
    for (let i = 0; i < BITS.length; i++) if (mask & (1 << i)) inp[BITS[i]] = true;
    return inp;
  }

  // ---- recording (server side) ---------------------------------------------

  class Recorder {
    constructor(seed) {
      this.seed = seed;
      this.lines = [];
      this.lastParts = [null, null]; // last encoded part per player
      this.lastEmittedTick = 0;
      this.ticks = 0;
      this.rounds = [0]; // tick each round starts at (round 1 = tick 0)
    }

    // Call once per game.step with the tick it produced and the inputs fed.
    record(tick, inp0, inp1) {
      this.ticks = tick;
      const p0 = packInput(inp0);
      const p1 = packInput(inp1);
      const c0 = p0 !== this.lastParts[0];
      const c1 = p1 !== this.lastParts[1];
      if (!c0 && !c1) return;
      this.lines.push(
        (tick - this.lastEmittedTick) + " " + (c0 ? p0 : ".") + " " + (c1 ? p1 : ".")
      );
      this.lastEmittedTick = tick;
      this.lastParts[0] = p0;
      this.lastParts[1] = p1;
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

  function decode(text) {
    const lines = String(text).split("\n");
    if (!lines[0] || lines[0].indexOf(MAGIC) !== 0) {
      throw new Error("Not a Cube Wars replay file.");
    }
    const meta = JSON.parse(lines[1]);
    if (meta.v !== VERSION) {
      throw new Error("Replay version " + meta.v + " is not supported by this client.");
    }
    // Change list: [absoluteTick, part0|null, part1|null]
    const changes = [];
    let t = 0;
    for (let i = 2; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (!ln) continue;
      const sp1 = ln.indexOf(" ");
      const sp2 = ln.indexOf(" ", sp1 + 1);
      t += parseInt(ln.slice(0, sp1), 10);
      const a = ln.slice(sp1 + 1, sp2);
      const b = ln.slice(sp2 + 1);
      changes.push([t, a === "." ? null : a, b === "." ? null : b]);
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
      this.current = [unpackInput("0,0"), unpackInput("0,0")];
    }

    inputsFor(tick) {
      while (this.idx < this.changes.length && this.changes[this.idx][0] <= tick) {
        const ch = this.changes[this.idx++];
        if (ch[1]) this.current[0] = unpackInput(ch[1]);
        if (ch[2]) this.current[1] = unpackInput(ch[2]);
      }
      return this.current;
    }
  }

  const api = { VERSION: VERSION, Recorder: Recorder, decode: decode, Cursor: Cursor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CubeArenaReplay = api;
})(typeof window !== "undefined" ? window : globalThis);
