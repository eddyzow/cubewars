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

      // Pre-apply state, for authoritative-delta feedback below.
      const preHp = [g.cubes[0].hp, g.cubes[1].hp];
      const preWins = g.roundWins ? g.roundWins.slice() : [0, 0];

      // Adopt the authoritative state wholesale...
      g.applySnapshot(data.snap);

      // AUTHORITATIVE FEEDBACK: prediction can miss hits entirely (the remote
      // player's swing may resolve only on the server). If the snapshot shows
      // HP lower than anything the local sim produced, force the hit feedback
      // — flash, sparks, sound, damage number — so both screens always react.
      const r = this.controller && this.controller.renderer;
      if (r) {
        const now = performance.now();
        this._lastAuthHit = this._lastAuthHit || [0, 0];
        for (let i = 0; i < 2; i++) {
          const drop = preHp[i] - g.cubes[i].hp;
          // Regen makes predicted HP run ~a tick AHEAD of the snapshot, so
          // tiny positive deltas are drift, not damage. Real hits are >= 3
          // (shot); anything below 2.5 is noise and must not fire feedback —
          // the phantom "-1"s also ate the rate-limit window and suppressed
          // genuine slam feedback.
          if (drop >= 2.5 && now - this._lastAuthHit[i] > 140) {
            this._lastAuthHit[i] = now;
            r.showAuthoritativeHit(i, drop);
          }
        }
        // Round transitions are ONLY shown from server truth in net mode.
        if (g.roundWins && (g.roundWins[0] !== preWins[0] || g.roundWins[1] !== preWins[1])) {
          const rw = g.roundWins[0] > preWins[0] ? 0 : 1;
          r.showRoundBanner(rw, g.roundWins);
        }
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
