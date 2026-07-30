// arenaNet.js — client side of online matches.
//
// Model: the server runs the only real game. The client:
//   1. sends every input frame with a sequence number,
//   2. PREDICTS its own cube by stepping a local copy of the sim immediately,
//   3. on each authoritative snapshot: adopts it, then re-applies all inputs
//      the server hasn't processed yet (reconciliation).
// Your cube feels instant; the opponent is server-truth smoothed by the
// renderer's interpolation. Mispredictions converge within a snapshot or two.
//
// The engine being deterministic is what makes the replay step valid.

(function (root) {
  "use strict";

  const A = root.CubeArena;

  class NetSession {
    constructor(socket) {
      this.socket = socket;
      this.active = false;
      this.controller = null;
      this.myIndex = 0;
      this.seq = 0;
      this.pending = []; // inputs the server hasn't acked yet
      this.lastRemoteInput = A.makeInput();
      this.onMatchFound = null; // set by main.js
      this.onOpponentLeft = null;

      socket.on("match-found", (data) => {
        this.myIndex = data.youAre;
        this.seq = 0;
        this.pending = [];
        this.lastRemoteInput = A.makeInput();
        this.active = true;
        if (this.onMatchFound) this.onMatchFound(data);
      });

      socket.on("match-state", (data) => this._onState(data));

      // Authoritative FX events — the single source for hits, KOs, items and
      // opponent actions. Reliable channel, so nothing is ever missed.
      socket.on("match-events", (evs) => {
        const r = this.controller && this.controller.renderer;
        if (r && this.active) r.consumeServerEvents(evs);
      });

      socket.on("match-over", (data) => {
        // Authoritative end. The local sim may not have registered the KO yet
        // (e.g. forfeit); force it so the controller's over-handler fires.
        const g = this.game();
        if (g && !g.over) {
          g.over = true;
          g.winner = data.winner;
        }
        this.active = false;
      });

      socket.on("opponent-left", () => {
        if (this.onOpponentLeft) this.onOpponentLeft();
      });
    }

    game() {
      return this.controller ? this.controller.game : null;
    }

    // Hooks handed to ArenaController so it drives the net path instead of a bot.
    hooks() {
      const self = this;
      return {
        drive: "net",
        getRemoteInput() {
          // Best guess for the opponent between snapshots: their last known
          // input. Wrong guesses are corrected by the next snapshot.
          return self.lastRemoteInput;
        },
        onLocalInput(inp, tick) {
          self.seq++;
          const rec = { seq: self.seq, inp: inp };
          self.pending.push(rec);
          if (self.pending.length > 96) self.pending.shift(); // ~3s cap
          // volatile: a dropped input frame is stale by the time it'd retry
          self.socket.volatile.emit("match-input", rec);
        },
      };
    }

    _onState(data) {
      const g = this.game();
      if (!g || !this.active) return;

      // Events already queued by normal forward stepping (including the
      // OPPONENT's swings and shots, driven by their replicated input) must
      // survive reconciliation — nuking them ate the other player's attack
      // visuals and sounds. Only the duplicates produced by the replay below
      // should be discarded.
      const pendingEvents = g.events;
      g.events = [];

      // Adopt the authoritative state wholesale...
      g.applySnapshot(data.snap);

      // Hit/action feedback now comes EXCLUSIVELY from server "match-events"
      // (reliable). The old hp-delta fallback fired alongside them and caused
      // duplicate hit effects, so it is gone.
      const r = this.controller && this.controller.renderer;
      if (r) {
        // Ground items render from snapshot truth only — local prediction of
        // spawns/pickups made phantoms blink in for a frame.
        r._snapPowerups = data.snap.powerups || [];
        r._snapHp = [data.snap.cubes[0].hp, data.snap.cubes[1].hp];
        // Round transitions compare SNAPSHOT-to-SNAPSHOT, never against the
        // local prediction: prediction can register a KO before the server
        // does, and comparing against it made a merely-behind snapshot look
        // like the OPPONENT scored ("round lost" + score going down). Server
        // win counts are monotonic, so snapshot deltas are unambiguous.
        const snapWins = (data.snap && data.snap.roundWins) || null;
        if (snapWins && this._lastSnapWins) {
          if (snapWins[0] > this._lastSnapWins[0]) r.showRoundBanner(0, snapWins);
          else if (snapWins[1] > this._lastSnapWins[1]) r.showRoundBanner(1, snapWins);
        }
        if (snapWins) this._lastSnapWins = snapWins.slice();
        if (g.round !== undefined && this._lastRound !== undefined && g.round > this._lastRound) {
          r.showRoundStart(g.round);
        }
        this._lastRound = g.round;
      }
      if (data.remoteInput) this.lastRemoteInput = data.remoteInput;

      // ...drop everything the server has already processed...
      const ack = data.ack || 0;
      while (this.pending.length && this.pending[0].seq <= ack) this.pending.shift();

      // ...and replay the rest so my cube is ahead of the snapshot again.
      for (const rec of this.pending) {
        const mine = rec.inp;
        const theirs = this.lastRemoteInput;
        const inputs = this.myIndex === 0 ? [mine, theirs] : [theirs, mine];
        g.step(inputs);
      }
      // Replay events are duplicates of ones the renderer already showed;
      // restore the genuine pending queue instead.
      g.events = pendingEvents;
    }

    leave() {
      this.active = false;
      this.socket.emit("queue-leave");
    }
  }

  root.CubeArenaNet = { NetSession };
})(typeof window !== "undefined" ? window : globalThis);
