// arenaController.js — input, fixed-timestep loop, bot, and (later) netcode.
//
// Runs the sim at exactly TICK_RATE regardless of display refresh, with an
// accumulator. The renderer interpolates between sim states, so 32Hz sim +
// 144Hz monitor still looks smooth.
//
// Two drive modes:
//   local  — both cubes simulated here (you + bot). Used by ZEN/practice.
//   online — server is authoritative; we predict our own cube and reconcile.
//            (wired in arenaNet.js)

(function (root) {
  "use strict";

  const A = root.CubeArena;

  // --- bot ------------------------------------------------------------------
  // Simple but honest: it uses the same input interface a player does, so it
  // can't do anything a human couldn't. Difficulty knobs are reaction time and
  // aim wobble.
  class Bot {
    constructor(game, myIdx, opts) {
      opts = opts || {};
      this.game = game;
      this.me = myIdx;
      this.wobble = opts.wobble === undefined ? 0.35 : opts.wobble; // radians of aim error
      this.reaction = opts.reaction === undefined ? 0.22 : opts.reaction; // seconds
      this.aggro = opts.aggro === undefined ? 0.55 : opts.aggro;
      this._timer = 0;
      this._decided = null;
      this._strafeDir = 1;
      this._strafeT = 0;
    }

    think(dtSec) {
      this._timer -= dtSec;
      this._strafeT -= dtSec;
      if (this._strafeT <= 0) {
        this._strafeT = 0.6 + Math.random() * 1.1;
        this._strafeDir = Math.random() < 0.5 ? -1 : 1;
      }
      if (this._timer <= 0 || !this._decided) {
        this._timer = this.reaction;
        this._decided = this._decide();
      }
      return this._decided;
    }

    _decide() {
      const inp = A.makeInput();
      const me = this.game.cubes[this.me];
      const foe = this.game.cubes[1 - this.me];
      if (!me.alive || !foe.alive) return inp;

      const dx = foe.x - me.x;
      const dy = foe.y - me.y;
      const dist = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      inp.aim = ang + (Math.random() - 0.5) * this.wobble;

      // Chase nearby items; chase medkits harder when hurt.
      let target = null;
      for (const p of this.game.powerups) {
        const pd = Math.hypot(p.x - me.x, p.y - me.y);
        if (pd < 190 || (p.kind === "medkit" && me.hp < 55 && pd < 420)) {
          if (!target || pd < target.d) target = { x: p.x, y: p.y, d: pd };
        }
      }

      const desired = me.hp < 30 && foe.hp > 30 ? 340 : this.aggro > Math.random() ? 40 : 190;

      let moveAng;
      if (target) {
        moveAng = Math.atan2(target.y - me.y, target.x - me.x);
      } else if (dist > desired + 30) {
        moveAng = ang; // close in
      } else if (dist < desired - 30) {
        moveAng = ang + Math.PI; // back off
      } else {
        moveAng = ang + (Math.PI / 2) * this._strafeDir; // orbit
      }

      // Convert the angle into WASD-ish booleans.
      const mx = Math.cos(moveAng);
      const my = Math.sin(moveAng);
      inp.right = mx > 0.38;
      inp.left = mx < -0.38;
      inp.down = my > 0.38;
      inp.up = my < -0.38;

      // Attack choices.
      if (dist < A.MELEE_REACH + 20 && me.meleeCd <= 0) inp.melee = true;
      else if (dist > 130 && me.shotCd <= 0 && Math.random() < 0.8) inp.shoot = true;

      // Dash to close distance, to escape when hurt, or to dodge a near shot.
      let incoming = false;
      for (const s of this.game.shots) {
        if (s.owner === this.me) continue;
        const t = Math.hypot(s.x - me.x, s.y - me.y);
        if (t < 130) incoming = true;
      }
      if (me.dashCd <= 0) {
        if (incoming && Math.random() < 0.6) inp.dash = true;
        else if (me.hp < 25 && dist < 120) inp.dash = true;
        else if (dist > 260 && this.aggro > 0.5 && Math.random() < 0.25) inp.dash = true;
      }
      return inp;
    }
  }

  // --- controller -----------------------------------------------------------
  class ArenaController {
    constructor(opts) {
      opts = opts || {};
      this.stageEl = opts.stage;
      this.mode = opts.mode || "practice";
      this.onExit = opts.onExit || function () {};
      this.onMatchOver = opts.onMatchOver || function () {};
      this.onRestart = opts.onRestart || null;
      this.botOpts = opts.bot || {};

      this.game = null;
      this.renderer = null;
      this.bot = null;
      this.running = false;
      this.myIndex = opts.myIndex || 0;

      this.keys = {};
      this.mouse = { x: 0, y: 0, down: false };
      this.acc = 0;
      this.lastT = 0;

      // netHooks lets arenaNet.js take over input routing without subclassing:
      //   { getRemoteInput(), onLocalInput(inp, tick), drive: "net" }
      this.netHooks = opts.netHooks || null;

      this._onKeyDown = this._onKeyDown.bind(this);
      this._onKeyUp = this._onKeyUp.bind(this);
      this._onMouseMove = this._onMouseMove.bind(this);
      this._onMouseDown = this._onMouseDown.bind(this);
      this._onMouseUp = this._onMouseUp.bind(this);
      this._onCtx = (e) => e.preventDefault();
      this._loop = this._loop.bind(this);
    }

    start(seed) {
      this.stop();
      this.game = new A.ArenaGame({ seed: seed === undefined ? (Math.random() * 0x7fffffff) | 0 : seed });
      this.renderer = new root.CubeArenaRender.ArenaRenderer(this.stageEl, this.game, {
        myIndex: this.myIndex,
        netMode: !!this.netHooks,
      });
      if (!this.netHooks) this.bot = new Bot(this.game, 1, this.botOpts);

      this.running = true;
      this._overFired = false;
      this.keys = {};
      this._aimTick = 0;
      this._lastAim = undefined;
      this._prevAttack = false;
      this._prevDash = false;
      this.acc = 0;
      this.lastT = performance.now();

      // Frozen until the intro sequence (matchup screen + 3-2-1) finishes;
      // main.js orchestrates the DOM overlays and calls unfreeze() at GO.
      // Online, the server delays its first tick to match.
      this.frozen = true;

      document.addEventListener("keydown", this._onKeyDown);
      document.addEventListener("keyup", this._onKeyUp);
      const cv = this.renderer.app.view;
      cv.addEventListener("mousemove", this._onMouseMove);
      cv.addEventListener("mousedown", this._onMouseDown);
      window.addEventListener("mouseup", this._onMouseUp);
      cv.addEventListener("contextmenu", this._onCtx);

      // setInterval, NOT requestAnimationFrame: rAF pauses in background tabs,
      // which would freeze the sim (and forfeit online matches by inactivity).
      // The accumulator below keeps stepping exact regardless of callback
      // jitter; rendering stays on Pixi's ticker where rAF throttling is fine.
      this.timer = setInterval(this._loop, 1000 / A.TICK_RATE);
      return this;
    }

    unfreeze() {
      this.frozen = false;
      this.acc = 0;
      this.lastT = performance.now(); // don't fast-forward the frozen time
    }

    stop() {
      this.running = false;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      if (this._overTimer) {
        clearTimeout(this._overTimer);
        this._overTimer = null;
      }
      document.removeEventListener("keydown", this._onKeyDown);
      document.removeEventListener("keyup", this._onKeyUp);
      window.removeEventListener("mouseup", this._onMouseUp);
      if (this.renderer) {
        const cv = this.renderer.app.view;
        cv.removeEventListener("mousemove", this._onMouseMove);
        cv.removeEventListener("mousedown", this._onMouseDown);
        cv.removeEventListener("contextmenu", this._onCtx);
        this.renderer.destroy();
        this.renderer = null;
      }
      this.game = null;
      this.bot = null;
    }

    // -- input capture -------------------------------------------------------

    _onKeyDown(e) {
      if (!this.running) return;
      // Typing in a form field (post-match chat) must never be intercepted.
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
      const k = e.key.toLowerCase();
      if (k === "escape") {
        this.onExit();
        return;
      }
      if (k === "r" && !this.netHooks && this.onRestart) {
        // Practice-only restart (the in-game topbar is gone).
        this.onRestart();
        return;
      }
      this.keys[k] = true;
      if ([" ", "w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "e", "q"].includes(k)) {
        e.preventDefault();
      }
    }

    _onKeyUp(e) {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
      this.keys[e.key.toLowerCase()] = false;
    }

    _onMouseMove(e) {
      const r = this.renderer.app.view.getBoundingClientRect();
      // Canvas CSS size may differ from logical size; scale into sim space.
      let x = ((e.clientX - r.left) / r.width) * this.game.width;
      // The renderer mirrors the world for player 1; un-mirror the cursor so
      // aim lands where the player is actually pointing.
      if (this.renderer.mirror) x = this.game.width - x;
      this.mouse.x = x;
      this.mouse.y = ((e.clientY - r.top) / r.height) * this.game.height;
    }

    _onMouseDown(e) {
      if (e.button === 0) this.mouse.down = true;
      if (e.button === 2) this.keys["_rmb"] = true; // right-click melee
    }

    _onMouseUp(e) {
      if (e.button === 0) this.mouse.down = false;
      if (e.button === 2) this.keys["_rmb"] = false;
    }

    // Build this frame's input for my cube from current key/mouse state.
    // Bindings: WASD move, mouse aim, CLICK attack (auto melee/shoot by
    // range), SPACE dash, E use item, Q drop item.
    localInput() {
      const inp = A.makeInput();
      // During the pre-match countdown all inputs read as idle.
      if (this.frozen) return inp;
      const me = this.game.cubes[this.myIndex];
      inp.up = !!(this.keys["w"] || this.keys["arrowup"]);
      inp.down = !!(this.keys["s"] || this.keys["arrowdown"]);
      const keyLeft = !!(this.keys["a"] || this.keys["arrowleft"]);
      const keyRight = !!(this.keys["d"] || this.keys["arrowright"]);
      // Mirrored view: pressing D means "screen right", which is world-left.
      if (this.renderer && this.renderer.mirror) {
        inp.left = keyRight;
        inp.right = keyLeft;
      } else {
        inp.left = keyLeft;
        inp.right = keyRight;
      }
      // mouse.x is already un-mirrored into world space by _onMouseMove.
      // Aim is quantized to a 1/625-radian grid (~3,900 directions, 0.09°
      // steps) and sampled at 8Hz — EXCEPT on the tick an attack or dash is
      // first pressed, which forces a fresh sample so flicks fire exactly
      // where the cursor points. Idle cursor tracking is what gets coarse,
      // and the renderer's aim smoothing glides through it. Buttons stay
      // 32Hz-exact. This is what makes replays tiny: aim changes are rare
      // and small. The server quantizes identically, keeping client sim,
      // server sim, and replay playback on the same exact floats.
      const wantsAttack = !!(this.mouse.down || this.keys["_rmb"] || this.keys[" "]);
      const wantsDash = !!(this.keys["e"] || this.keys["shift"]);
      const edge =
        (wantsAttack && !this._prevAttack) || (wantsDash && !this._prevDash);
      this._prevAttack = wantsAttack;
      this._prevDash = wantsDash;
      this._aimTick = ((this._aimTick || 0) + 1) % 4;
      if (this._aimTick === 0 || edge || this._lastAim === undefined) {
        this._lastAim =
          Math.round(Math.atan2(this.mouse.y - me.y, this.mouse.x - me.x) * 625) / 625;
      }
      inp.aim = this._lastAim;

      // One attack button: melee when the opponent is in reach, shoot
      // otherwise. The decision replicates to the server via the input frame.
      // SPACE is a second attack trigger, identical to clicking.
      if (wantsAttack) {
        const foe = this.game.cubes[1 - this.myIndex];
        const inMelee =
          foe.alive &&
          Math.hypot(foe.x - me.x, foe.y - me.y) <=
            A.MELEE_REACH + A.CUBE_R;
        inp.melee = inMelee;
        inp.shoot = !inMelee;
      }

      inp.dash = wantsDash;
      return inp;
    }

    // -- main loop -----------------------------------------------------------

    _loop() {
      if (!this.running) return;

      const now = performance.now();
      // Clamp so a long throttle (backgrounded tab) fast-forwards at most a
      // few ticks per callback instead of spiralling.
      const dtMs = Math.min(250, now - this.lastT);
      this.lastT = now;
      this.acc += dtMs / 1000;

      const DT = A.DT;
      if (this.frozen) this.acc = 0; // countdown: hold the sim still
      while (this.acc >= DT) {
        this.acc -= DT;
        if (this.game.over) break;

        const mine = this.localInput();
        let theirs;
        if (this.netHooks) {
          theirs = this.netHooks.getRemoteInput();
          this.netHooks.onLocalInput(mine, this.game.tick + 1);
        } else {
          theirs = this.bot.think(DT);
        }

        const inputs = this.myIndex === 0 ? [mine, theirs] : [theirs, mine];
        this.game.step(inputs);
        // Stamp for the renderer: lets it extrapolate projectiles between sim
        // ticks so 32Hz stepping still renders as fluid 60fps+ motion.
        this.game._lastStepAt = performance.now();
      }

      this.renderer.consumeEvents();

      if (this.game.over && !this._overFired) {
        this._overFired = true;
        const w = this.game.winner;
        const stats = this.game.cubes.map((c) => ({
          hp: Math.max(0, Math.ceil(c.hp)),
          dealt: Math.round(c.damageDealt),
          hits: c.hitsLanded,
          shots: c.shotsFired,
        }));
        // Let the KO explosion play before the panel drops. Tracked so stop()
        // can cancel it — otherwise leaving during the KO (rematch/exit) lets
        // the old match's panel drop on top of whatever came next.
        this._overTimer = setTimeout(() => {
          this._overTimer = null;
          this.onMatchOver(w, stats);
        }, 900);
      }
    }
  }

  root.CubeArenaController = { ArenaController, Bot };
})(typeof window !== "undefined" ? window : globalThis);
