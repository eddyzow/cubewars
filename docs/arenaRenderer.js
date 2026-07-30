// arenaRenderer.js — Pixi presentation for the arena duel.
//
// Unlike the old stacker renderer (which only drew on discrete events and so
// looked static), this runs a continuous rAF loop: cubes interpolate, trails
// decay, particles live, and the whole scene is redrawn every frame. Motion is
// the point of an action game.
//
// Reads the sim, never mutates it.

(function (root) {
  "use strict";

  const P1_COLOR = 0x4f8cff;
  const P2_COLOR = 0xff5e6e;
  const BG = 0x0b0d12;
  const GRID = 0x161a23;
  const WALL = 0x2b3141;

  const PU_COLOR = {
    medkit: 0x52d16a,
    power: 0xffa63d,
    overdrive: 0x49dcf0,
    aegis: 0x9ad9ff,
  };

  function lighten(hex, a) {
    const r = Math.min(255, ((hex >> 16) & 0xff) + a);
    const g = Math.min(255, ((hex >> 8) & 0xff) + a);
    const b = Math.min(255, (hex & 0xff) + a);
    return (r << 16) | (g << 8) | b;
  }
  function darken(hex, a) {
    const r = Math.max(0, ((hex >> 16) & 0xff) - a);
    const g = Math.max(0, ((hex >> 8) & 0xff) - a);
    const b = Math.max(0, (hex & 0xff) - a);
    return (r << 16) | (g << 8) | b;
  }

  const SFX_FILES = {
    shoot: "assets/sound/sfx/cw-shoot.mp3",
    melee: "assets/sound/sfx/cw-melee.mp3",
    dash: "assets/sound/sfx/cw-dash.mp3",
    ko: "assets/sound/sfx/cw-ko.mp3",
    pickup: "assets/sound/sfx/cw-pickup.mp3",
    wall: "assets/sound/sfx/cw-wall.mp3",
    // Champion pack: match-flow stingers.
    countdown: "assets/sound/sfx/ch-321.mp3",
    matchBegin: "assets/sound/sfx/ch-matchBegin.mp3",
    matchPoint: "assets/sound/sfx/ch-matchPoint.mp3",
    roundWin: "assets/sound/sfx/level-up-wipe.mp3",
    victory: "assets/sound/sfx/ch-victory.mp3",
    defeat: "assets/sound/sfx/ch-defeat.mp3",
    intro1: "assets/sound/sfx/ch-act-intro1.mp3",
    intro2: "assets/sound/sfx/ch-act-intro2.mp3",
    intro3: "assets/sound/sfx/ch-act-intro3.mp3",
  };

  const Sfx = {
    sounds: {},
    enabled: true,
    volume: 0.55,
    init() {
      if (typeof Howl === "undefined") return;
      for (const k in SFX_FILES) {
        try {
          this.sounds[k] = new Howl({ src: [SFX_FILES[k]], volume: this.volume, preload: true });
        } catch (e) {}
      }
    },
    play(k, rate, vol) {
      if (!this.enabled) return;
      const s = this.sounds[k];
      if (!s) return;
      try {
        const id = s.play();
        if (rate && s.rate) s.rate(rate, id);
        if (vol !== undefined && s.volume) s.volume(vol * this.volume, id);
      } catch (e) {}
    },
  };

  class ArenaRenderer {
    constructor(mountEl, game, opts) {
      opts = opts || {};
      this.game = game;
      this.mount = mountEl;
      this.myIndex = opts.myIndex === undefined ? 0 : opts.myIndex;
      // Online, round transitions are shown ONLY from authoritative snapshots
      // (via arenaNet) — locally-predicted round events are suppressed so the
      // score can never display a stale value.
      this.netMode = !!opts.netMode;

      const W = game.width;
      const H = game.height;

      this.app = new PIXI.Application({
        width: W,
        height: H,
        backgroundAlpha: 0,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });
      mountEl.appendChild(this.app.view);

      this.root = new PIXI.Container();
      this.app.stage.addChild(this.root);

      // You are ALWAYS blue and always start on the left: player 1's client
      // renders the canonical world mirrored. Only world-space layers flip —
      // HUD and text stay upright.
      this.mirror = this.myIndex === 1;

      // Layers, back to front.
      this.world = new PIXI.Container();
      this.bgLayer = new PIXI.Graphics();
      this.trailLayer = new PIXI.Graphics();
      this.puLayer = new PIXI.Graphics();
      this.shotLayer = new PIXI.Graphics();
      this.cubeLayer = new PIXI.Graphics();
      this.fxLayer = new PIXI.Graphics();
      this.uiLayer = new PIXI.Container();
      this.world.addChild(this.bgLayer, this.trailLayer, this.puLayer, this.shotLayer, this.cubeLayer, this.fxLayer);
      if (this.mirror) {
        this.world.scale.x = -1;
        this.world.x = game.width;
      }
      this.root.addChild(this.world, this.uiLayer);

      this._drawBackground();
      this._buildUI();

      // Visual state, decoupled from sim state so we can interpolate and add
      // secondary motion (squash, recoil) without touching the rules.
      this.view = game.cubes.map((c) => ({
        x: c.x,
        y: c.y,
        aim: c.aim,
        squash: 0,
        recoil: 0,
        spin: 0,
        hpShown: c.hp,
      }));

      this.trails = []; // {x,y,color,life,max,r}
      this.particles = []; // {x,y,vx,vy,life,max,color,r}
      this.floaters = []; // damage numbers
      this.swings = []; // melee arc flashes
      this.shake = 0;
      this.timeSec = 0;
      this.hitStop = 0; // brief freeze on big hits, makes impacts land

      this.app.ticker.add(this._frame, this);
    }

    _drawBackground() {
      const g = this.bgLayer;
      const W = this.game.width;
      const H = this.game.height;
      // Mostly-opaque floor: the animated colour glow (a CSS layer behind the
      // canvas) bleeds through the gaps, giving the arena a living backdrop
      // without costing any canvas time.
      g.beginFill(BG, 0.82);
      g.drawRect(0, 0, W, H);
      g.endFill();

      // Grid, for a sense of speed as you move across it.
      g.lineStyle(1, GRID, 0.9);
      for (let x = 0; x <= W; x += 45) {
        g.moveTo(x, 0);
        g.lineTo(x, H);
      }
      for (let y = 0; y <= H; y += 45) {
        g.moveTo(0, y);
        g.lineTo(W, y);
      }
      g.lineStyle(0);

      // Centre line + circle, so the arena reads as a duelling ground.
      g.lineStyle(2, 0x232a38, 1);
      g.moveTo(W / 2, 0);
      g.lineTo(W / 2, H);
      g.drawCircle(W / 2, H / 2, 74);
      g.lineStyle(0);

      // Crates: three visual designs so cover doesn't repeat. All beveled in
      // the cube language.
      for (const o of this.game.obstacles) {
        // Common base + face.
        g.beginFill(0x11141b, 1);
        g.drawRoundedRect(o.x - 3, o.y - 3, o.w + 6, o.h + 6, 5);
        g.endFill();
        g.beginFill(0x3a4152, 1);
        g.drawRoundedRect(o.x, o.y, o.w, o.h, 4);
        g.endFill();
        g.beginFill(0x4d566c, 1);
        g.drawRoundedRect(o.x + 4, o.y + 4, o.w - 8, (o.h - 8) * 0.3, 3);
        g.endFill();

        if (o.style === 0) {
          // Braced crate: X cross.
          g.lineStyle(2, 0x2b3141, 1);
          g.moveTo(o.x + 5, o.y + 5);
          g.lineTo(o.x + o.w - 5, o.y + o.h - 5);
          g.moveTo(o.x + o.w - 5, o.y + 5);
          g.lineTo(o.x + 5, o.y + o.h - 5);
          g.lineStyle(0);
        } else if (o.style === 1) {
          // Hazard block: diagonal stripes.
          g.lineStyle(4, 0x565f76, 0.55);
          const step = 16;
          for (let d = -o.h; d < o.w; d += step) {
            const x1 = Math.max(o.x + 4, o.x + d);
            const y1 = d < 0 ? o.y + 4 - d : o.y + 4;
            const x2 = Math.min(o.x + o.w - 4, o.x + d + o.h);
            const y2 = d + o.h > o.w ? o.y + (o.w - d) - 4 : o.y + o.h - 4;
            if (x2 > x1) {
              g.moveTo(x1, y1);
              g.lineTo(x2, y2);
            }
          }
          g.lineStyle(0);
        } else {
          // Vent block: horizontal slats.
          g.beginFill(0x2b3141, 1);
          const slats = Math.max(2, Math.floor((o.h - 16) / 14));
          for (let sIdx = 0; sIdx < slats; sIdx++) {
            const sy = o.y + 10 + sIdx * ((o.h - 20) / slats);
            g.drawRoundedRect(o.x + 8, sy, o.w - 16, 5, 2);
          }
          g.endFill();
        }
      }

      // Walls.
      g.lineStyle(3, WALL, 1);
      g.drawRoundedRect(1.5, 1.5, W - 3, H - 3, 6);
      g.lineStyle(0);
    }

    _buildUI() {
      const W = this.game.width;
      const mkText = (x, y, size, color, anchor) => {
        const t = new PIXI.Text("", {
          fontFamily: "IBM Plex Mono, monospace",
          fontSize: size,
          fontWeight: "700",
          fill: color,
          letterSpacing: 1.2,
        });
        t.x = x;
        t.y = y;
        if (anchor) t.anchor.set(anchor[0], anchor[1]);
        this.uiLayer.addChild(t);
        return t;
      };

      this.hpBars = new PIXI.Graphics();
      this.uiLayer.addChild(this.hpBars);

      this.p1Name = mkText(22, 16, 13, 0xdfe6f5);
      this.p1Name.text = "YOU";
      this.p2Name = mkText(W - 22, 16, 13, 0xdfe6f5, [1, 0]);
      this.p2Name.text = "OPPONENT";

      this.p1Hp = mkText(22, 52, 11, 0x8b93a7);
      this.p2Hp = mkText(W - 22, 52, 11, 0x8b93a7, [1, 0]);

      // Cooldown pips, top-centre between the HP bars, clear of the help strip.
      this.cdGfx = new PIXI.Graphics();
      this.uiLayer.addChild(this.cdGfx);
      this.cdLabel = mkText(this.game.width / 2, 14, 9.5, 0x5d6478, [0.5, 0]);
      this.cdLabel.text = "DASH            MELEE            SHOT";

      // Ping readout, bottom-right corner of the arena.
      this.pingMs = null; // set externally; null = local play
      this.pingText = mkText(W - 14, this.game.height - 24, 11, 0x5d6478, [1, 0]);

      // Round score (first to 3), top centre.
      this.scoreText = mkText(W / 2, 50, 26, 0xffffff, [0.5, 0]);
      this.scoreText.style.fontFamily = "IBM Plex Sans Condensed, IBM Plex Sans, sans-serif";
      this._lastRoundBannerAt = 0; // throttle round banners (local + net race)
    }

    // Identity colours: my cube is always P1 blue, the opponent always red.
    _col(cubeId) {
      return cubeId === this.myIndex ? P1_COLOR : P2_COLOR;
    }

    // Mirror an x coordinate for elements OUTSIDE the flipped world container
    // (text must not render backwards).
    mx(x) {
      return this.mirror ? this.game.width - x : x;
    }

    // ---- effect spawners, called from consumeEvents -------------------------

    _spark(x, y, color, count, speed, life) {
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = speed * (0.4 + Math.random() * 0.6);
        this.particles.push({
          x: x,
          y: y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s,
          life: 0,
          max: life * (0.6 + Math.random() * 0.6),
          color: color,
          r: 1.6 + Math.random() * 2.4,
        });
      }
    }

    _floater(x, y, text, color, size) {
      const t = new PIXI.Text(text, {
        fontFamily: "IBM Plex Sans Condensed, IBM Plex Sans, sans-serif",
        fontSize: size || 20,
        fontWeight: "700",
        fill: color,
        stroke: 0x000000,
        strokeThickness: 4,
      });
      t.anchor.set(0.5);
      t.x = this.mx(x); // text lives outside the mirrored world
      t.y = y;
      this.fxTextLayer = this.fxTextLayer || (() => {
        const c = new PIXI.Container();
        this.root.addChild(c);
        return c;
      })();
      this.fxTextLayer.addChild(t);
      this.floaters.push({ obj: t, life: 0, max: 0.85, x: this.mx(x), y: y });
    }

    // My own instant-feedback actions: played from the LOCAL sim the moment
    // the input happens (zero latency), so server copies are skipped.
    _isMyInstantAction(e) {
      return (
        e.cube === this.myIndex &&
        ["shoot", "dash", "melee_swing", "melee_whiff"].includes(e.type)
      );
    }

    consumeEvents() {
      const evs = this.game.drainEvents();
      for (const e of evs) {
        if (this.netMode) {
          // Online: local prediction is trusted only for MY instant actions
          // (plus cosmetic shot-wall pops). Hits, KOs, items and everything
          // the OPPONENT does play from authoritative server events instead,
          // so no sound can go missing or double.
          if (!this._isMyInstantAction(e) && e.type !== "shot_wall") continue;
        }
        this._handleEvent(e);
      }
    }

    // Authoritative events from the server (net mode): everything except my
    // already-played instant actions and the snapshot-driven round flow.
    consumeServerEvents(evs) {
      if (!evs) return;
      for (const e of evs) {
        if (this._isMyInstantAction(e)) continue;
        if (e.type === "shot_wall") continue;
        if (e.type === "round_over" || e.type === "round_start" || e.type === "match_over") continue;
        this._handleEvent(e);
      }
    }

    _handleEvent(e) {
      {
        switch (e.type) {
          case "shoot": {
            Sfx.play("shoot", 0.95 + Math.random() * 0.12);
            const c = this.view[e.cube];
            if (c) c.recoil = 1;
            this._spark(e.x, e.y, 0xfff2c4, 5, 150, 0.16);
            this.shake = Math.max(this.shake, 2.2);
            break;
          }
          case "melee_swing": {
            Sfx.play("dash", 1.35, 0.4);
            this.swings.push({ x: e.x, y: e.y, aim: e.aim, life: 0, max: 0.2, cube: e.cube });
            const c = this.view[e.cube];
            if (c) c.squash = 1;
            break;
          }
          case "melee_hit": {
            if (e.blocked) {
              Sfx.play("wall", 1.4, 0.5);
              this._floater(e.x, e.y - 26, "BLOCKED", 0x9ad9ff, 15);
              this._spark(e.x, e.y, 0x9ad9ff, 10, 200, 0.3);
            } else {
              Sfx.play("melee", 0.95 + Math.random() * 0.1);
              this._spark(e.x, e.y, 0xffd08a, 22, 340, 0.42);
              this._floater(e.x, e.y - 28, "-" + Math.round(e.dmg), 0xffc46b, 24);
              this.shake = Math.max(this.shake, 15);
              this.hitStop = 0.055; // freeze frame sells the impact
              const t = this.view[e.target];
              if (t) t.squash = 1.2;
            }
            break;
          }
          case "melee_whiff":
            Sfx.play("wall", 1.9, 0.18);
            break;
          case "dash_hit": {
            if (e.blocked) {
              Sfx.play("wall", 1.3, 0.5);
              this._spark(e.x, e.y, 0x9ad9ff, 12, 260, 0.3);
            } else {
              Sfx.play("melee", 0.8);
              this._spark(e.x, e.y, 0xffffff, 26, 420, 0.5);
              this._floater(e.x, e.y - 30, "SLAM -" + Math.round(e.dmg), 0xffffff, 26);
              this.shake = Math.max(this.shake, 20);
              this.hitStop = 0.07;
              const t = this.view[e.target];
              if (t) t.squash = 1.4;
            }
            break;
          }
          case "shield_absorb": {
            Sfx.play("wall", 1.6, 0.5);
            this._spark(e.x, e.y, PU_COLOR.aegis, 14, 240, 0.35);
            if (e.broken) this._floater(e.x, e.y - 26, "SHIELD BREAK", PU_COLOR.aegis, 18);
            break;
          }
          case "shot_hit": {
            if (e.blocked) {
              Sfx.play("wall", 1.4, 0.45);
              this._spark(e.x, e.y, 0x9ad9ff, 8, 170, 0.26);
            } else {
              Sfx.play("wall", 1.7, 0.6); // projectile impact thud
              this._spark(e.x, e.y, 0xffb0b0, 12, 220, 0.3);
              this._floater(e.x, e.y - 20, "-" + Math.round(e.dmg), 0xff9a9a, 16);
              this.shake = Math.max(this.shake, 5);
              const t = this.view[e.target];
              if (t) t.squash = 0.5;
            }
            break;
          }
          case "shot_wall":
            Sfx.play("wall", 1.1, 0.3);
            this._spark(e.x, e.y, 0x8892a8, 6, 130, 0.22);
            break;
          case "dash": {
            Sfx.play("dash", 1.0 + Math.random() * 0.1);
            const c = this.view[e.cube];
            if (c) c.squash = 1;
            this._spark(e.x, e.y, this._col(e.cube), 14, 210, 0.3);
            this.shake = Math.max(this.shake, 4);
            break;
          }
          case "item_pickup":
            Sfx.play("pickup", 1.15, 0.7);
            this._spark(e.x, e.y, PU_COLOR[e.kind] || 0xffffff, 12, 180, 0.35);
            break;
          case "item_use":
            Sfx.play("pickup", 0.9);
            this._spark(e.x, e.y, PU_COLOR[e.kind] || 0xffffff, 22, 260, 0.5);
            this._floater(e.x, e.y - 26, e.kind.toUpperCase(), PU_COLOR[e.kind] || 0xffffff, 18);
            break;
          case "item_drop":
            Sfx.play("wall", 1.2, 0.4);
            break;
          case "pu_spawn":
            this._spark(e.x, e.y, PU_COLOR[e.kind] || 0xffffff, 10, 120, 0.4);
            break;
          case "round_over": {
            if (!this.netMode) this.showRoundBanner(e.winner, e.wins);
            break;
          }
          case "round_start": {
            if (!this.netMode) this.showRoundStart(e.round);
            break;
          }
          case "ko": {
            Sfx.play("ko");
            const col = this._col(e.cube);
            this._spark(e.x, e.y, col, 60, 520, 0.9);
            this._spark(e.x, e.y, 0xffffff, 30, 340, 0.7);
            this.shake = 34;
            this.hitStop = 0.12;
            break;
          }
          case "match_over":
            // Jingles fire from the result panel (covers forfeits too).
            break;
        }
      }
    }

    // ---- per-frame ---------------------------------------------------------

    _frame(delta) {
      // Pixi's delta is in frames (1 == 60fps); convert to seconds.
      const dt = Math.min(0.05, (delta / 60) * (this.app.ticker.deltaMS / (1000 / 60)) || delta / 60);
      const step = this.app.ticker.deltaMS / 1000;
      this.timeSec += step;

      if (this.hitStop > 0) {
        this.hitStop -= step;
        // Still render during hit-stop, just don't advance interpolation.
        this._render(0);
        return;
      }

      this._render(step);
    }

    _render(step) {
      const g = this.game;

      // Interpolate the drawn position toward the sim position. At 32Hz sim vs
      // 60Hz display this is what keeps motion smooth rather than steppy.
      for (let i = 0; i < g.cubes.length; i++) {
        const c = g.cubes[i];
        const v = this.view[i];
        // My cube snaps fast (it's prediction, already correct); the
        // opponent gets heavier smoothing to hide snapshot/replay jitter.
        const k = 1 - Math.pow(i === this.myIndex ? 0.0016 : 0.03, step);
        v.x += (c.x - v.x) * k;
        v.y += (c.y - v.y) * k;
        // Aim follows quickly but not instantly, so turning reads as motion.
        let d = c.aim - v.aim;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        v.aim += d * (1 - Math.pow(0.0001, step));
        v.squash = Math.max(0, v.squash - step * 5.5);
        v.recoil = Math.max(0, v.recoil - step * 7);
        v.hpShown += (c.hp - v.hpShown) * (1 - Math.pow(0.002, step));

        // Motion trail while moving fast.
        const sp = Math.hypot(c.vx, c.vy);
        if (sp > 240 && c.alive) {
          this.trails.push({
            x: v.x,
            y: v.y,
            color: this._col(i),
            life: 0,
            max: 0.3,
            r: 13 * (sp > 500 ? 1.25 : 1),
          });
        }
      }

      // Advance transient effects.
      for (let i = this.trails.length - 1; i >= 0; i--) {
        const t = this.trails[i];
        t.life += step;
        if (t.life >= t.max) this.trails.splice(i, 1);
      }
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.life += step;
        if (p.life >= p.max) {
          this.particles.splice(i, 1);
          continue;
        }
        p.x += p.vx * step;
        p.y += p.vy * step;
        p.vx *= 1 - 3.2 * step;
        p.vy *= 1 - 3.2 * step;
      }
      for (let i = this.swings.length - 1; i >= 0; i--) {
        const s = this.swings[i];
        s.life += step;
        if (s.life >= s.max) this.swings.splice(i, 1);
      }
      for (let i = this.floaters.length - 1; i >= 0; i--) {
        const f = this.floaters[i];
        f.life += step;
        const t = f.life / f.max;
        if (t >= 1) {
          if (f.obj.parent) f.obj.parent.removeChild(f.obj);
          f.obj.destroy();
          this.floaters.splice(i, 1);
          continue;
        }
        f.obj.y = f.y - 34 * t;
        f.obj.alpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
        f.obj.scale.set(0.85 + 0.25 * Math.min(1, t / 0.18));
      }

      // Screen shake (user-disableable in settings).
      if (root.CubeWarsSettings && root.CubeWarsSettings.shake === false) this.shake = 0;
      if (this.shake > 0.2) {
        this.root.x = (Math.random() - 0.5) * this.shake;
        this.root.y = (Math.random() - 0.5) * this.shake;
        this.shake *= Math.pow(0.0016, step);
      } else if (this.root.x || this.root.y) {
        this.root.x = 0;
        this.root.y = 0;
        this.shake = 0;
      }

      this._drawTrails();
      this._drawPowerups();
      this._drawShots();
      this._drawCubes();
      this._drawFx();
      this._drawHud();
    }

    _drawTrails() {
      const g = this.trailLayer;
      g.clear();
      for (const t of this.trails) {
        const k = 1 - t.life / t.max;
        g.beginFill(t.color, 0.2 * k);
        g.drawCircle(t.x, t.y, t.r * k);
        g.endFill();
      }
    }

    // Draw one item icon at (x, y) with size r. Used for both ground items and
    // the held-item HUD slot.
    _drawItemIcon(g, kind, x, y, r) {
      const col = PU_COLOR[kind] || 0xffffff;
      if (kind === "medkit") {
        g.beginFill(0xf2f5fa, 1);
        g.drawRoundedRect(x - r, y - r * 0.75, r * 2, r * 1.5, 4);
        g.endFill();
        g.beginFill(0x52d16a, 1);
        g.drawRect(x - r * 0.55, y - r * 0.18, r * 1.1, r * 0.36);
        g.drawRect(x - r * 0.18, y - r * 0.55, r * 0.36, r * 1.1);
        g.endFill();
      } else if (kind === "power") {
        // Power core: orange diamond with hot centre.
        g.beginFill(col, 1);
        g.moveTo(x, y - r);
        g.lineTo(x + r, y);
        g.lineTo(x, y + r);
        g.lineTo(x - r, y);
        g.closePath();
        g.endFill();
        g.beginFill(0xfff2c4, 1);
        g.drawCircle(x, y, r * 0.32);
        g.endFill();
      } else if (kind === "overdrive") {
        // Double chevron pointing right.
        g.beginFill(col, 1);
        for (const off of [-r * 0.45, r * 0.25]) {
          g.moveTo(x + off - r * 0.3, y - r * 0.7);
          g.lineTo(x + off + r * 0.4, y);
          g.lineTo(x + off - r * 0.3, y + r * 0.7);
          g.lineTo(x + off - r * 0.05, y);
          g.closePath();
        }
        g.endFill();
      } else {
        // Aegis: ring + dot.
        g.lineStyle(3.5, col, 1);
        g.drawCircle(x, y, r * 0.75);
        g.lineStyle(0);
        g.beginFill(col, 1);
        g.drawCircle(x, y, r * 0.26);
        g.endFill();
      }
    }

    _drawPowerups() {
      const g = this.puLayer;
      g.clear();
      const R = root.CubeArena.PU_R;
      for (const p of this.game.powerups) {
        const col = PU_COLOR[p.kind] || 0xffffff;
        const bob = Math.sin(this.timeSec * 3 + p.x * 0.05) * 3;
        const pulse = 0.75 + 0.25 * Math.sin(this.timeSec * 5 + p.y * 0.05);
        // Halo so the single map item draws the eye from anywhere.
        g.beginFill(col, 0.12 * pulse);
        g.drawCircle(p.x, p.y + bob, R * 2.3);
        g.endFill();
        g.lineStyle(1.5, col, 0.5 * pulse);
        g.drawCircle(p.x, p.y + bob, R * 1.55);
        g.lineStyle(0);
        this._drawItemIcon(g, p.kind, p.x, p.y + bob, R);
      }
    }

    _drawShots() {
      const g = this.shotLayer;
      g.clear();
      const R = root.CubeArena.SHOT_R;
      // Extrapolate by the time elapsed since the last sim tick. Bullets are
      // the fastest thing on screen, so they'd visibly stutter at 32Hz without
      // this; positions are linear between ticks, so extrapolation is exact.
      const alpha = this.game._lastStepAt
        ? Math.min(root.CubeArena.DT, (performance.now() - this.game._lastStepAt) / 1000)
        : 0;
      for (const s of this.game.shots) {
        const col = this._col(s.owner);
        const rr = R;
        const len = 16;
        const sx = s.x + s.vx * alpha;
        const sy = s.y + s.vy * alpha;
        const sp = Math.hypot(s.vx, s.vy) || 1;
        const nx = s.vx / sp;
        const ny = s.vy / sp;
        g.beginFill(col, 0.22);
        g.drawCircle(sx - nx * len * 0.6, sy - ny * len * 0.6, rr * 1.5);
        g.endFill();
        g.beginFill(lighten(col, 60), 0.95);
        g.drawCircle(sx, sy, rr);
        g.endFill();
        g.beginFill(0xffffff, 0.9);
        g.drawCircle(sx, sy, rr * 0.45);
        g.endFill();
      }
    }

    _drawCubes() {
      const g = this.cubeLayer;
      g.clear();
      const R = root.CubeArena.CUBE_R;

      for (let i = 0; i < this.game.cubes.length; i++) {
        const c = this.game.cubes[i];
        const v = this.view[i];
        if (!c.alive) continue;
        const col = this._col(i);

        // Squash along the direction of travel; classic secondary motion.
        const sp = Math.hypot(c.vx, c.vy);
        const moveAng = sp > 8 ? Math.atan2(c.vy, c.vx) : v.aim;

        // Dash i-frame ring.
        if (c.iframe > 0) {
          const k = c.iframe / root.CubeArena.DASH_CD;
          g.lineStyle(2.5, 0xffffff, 0.35 + 0.4 * Math.sin(this.timeSec * 30));
          g.drawCircle(v.x, v.y, R + 8 + k * 4);
          g.lineStyle(0);
        }

        // Buff auras.
        if (c.buffDmg > 0) {
          g.beginFill(PU_COLOR.power, 0.14);
          g.drawCircle(v.x, v.y, R + 12 + Math.sin(this.timeSec * 7) * 2);
          g.endFill();
        }
        if (c.buffSpeed > 0) {
          g.beginFill(PU_COLOR.overdrive, 0.13);
          g.drawCircle(v.x, v.y, R + 10 + Math.sin(this.timeSec * 9) * 2);
          g.endFill();
        }
        if (c.buffRapid > 0) {
          g.beginFill(PU_COLOR.overdrive, 0.12);
          g.drawCircle(v.x, v.y, R + 8 + Math.sin(this.timeSec * 11) * 2);
          g.endFill();
        }
        // Shield: solid hex-ish ring that thins as the pool depletes.
        if (c.shield > 0) {
          const frac = c.shield / root.CubeArena.SHIELD_POOL;
          g.lineStyle(2 + 3 * frac, PU_COLOR.aegis, 0.65);
          g.drawCircle(v.x, v.y, R + 7);
          g.lineStyle(0);
        }
        // Body: a rotated TRUE SQUARE — a cube seen top-down should never read
        // as a rectangle. Impacts pulse the whole square uniformly instead of
        // stretching one axis.
        const flash = c.hitFlash > 0;
        const body = flash ? 0xffffff : col;
        const rot = moveAng;
        const scale = 1 + v.squash * 0.14;
        const w = R * scale;
        const h = R * scale;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const corner = (sx, sy) => ({
          x: v.x + sx * w * cos - sy * h * sin,
          y: v.y + sx * w * sin + sy * h * cos,
        });
        const p1 = corner(-1, -1);
        const p2 = corner(1, -1);
        const p3 = corner(1, 1);
        const p4 = corner(-1, 1);

        g.beginFill(darken(body, flash ? 0 : 55), 1);
        g.moveTo(p1.x, p1.y);
        g.lineTo(p2.x, p2.y);
        g.lineTo(p3.x, p3.y);
        g.lineTo(p4.x, p4.y);
        g.closePath();
        g.endFill();

        // Inner face, slightly smaller, for depth.
        const inset = 0.62;
        const q1 = corner(-inset, -inset);
        const q2 = corner(inset, -inset);
        const q3 = corner(inset, inset);
        const q4 = corner(-inset, inset);
        g.beginFill(flash ? 0xffffff : lighten(body, 35), 1);
        g.moveTo(q1.x, q1.y);
        g.lineTo(q2.x, q2.y);
        g.lineTo(q3.x, q3.y);
        g.lineTo(q4.x, q4.y);
        g.closePath();
        g.endFill();

        // Gun barrel, pointing at aim, kicks back on recoil.
        const gunLen = R + 13 - v.recoil * 6;
        const gx = v.x + Math.cos(v.aim) * gunLen;
        const gy = v.y + Math.sin(v.aim) * gunLen;
        g.lineStyle(5, darken(col, 30), 1);
        g.moveTo(v.x + Math.cos(v.aim) * R * 0.5, v.y + Math.sin(v.aim) * R * 0.5);
        g.lineTo(gx, gy);
        g.lineStyle(0);
        g.beginFill(lighten(col, 70), 1);
        g.drawCircle(gx, gy, 3.2);
        g.endFill();

        // Melee tell for MY cube only: when the opponent is close enough that
        // clicking will swing instead of shoot, light up the whole swing zone.
        // This doubles as the "you are in knife range" warning.
        if (i === this.myIndex) {
          const other = this.game.cubes[1 - i];
          if (other.alive) {
            const d = Math.hypot(other.x - c.x, other.y - c.y);
            const reach = root.CubeArena.MELEE_REACH + R;
            if (d <= reach * 1.35) {
              const engaged = d <= reach; // click = melee right now
              const a0 = v.aim - root.CubeArena.MELEE_ARC / 2;
              const a1 = v.aim + root.CubeArena.MELEE_ARC / 2;
              const pulse = 0.75 + 0.25 * Math.sin(this.timeSec * 10);
              // Filled wedge.
              g.beginFill(engaged ? 0xffd166 : 0xffffff, engaged ? 0.14 * pulse : 0.05);
              g.moveTo(v.x, v.y);
              g.arc(v.x, v.y, root.CubeArena.MELEE_REACH, a0, a1);
              g.closePath();
              g.endFill();
              // Bold rim + edge ticks.
              g.lineStyle(engaged ? 4 : 2, engaged ? 0xffd166 : 0x8b93a7, engaged ? 0.85 * pulse : 0.3);
              g.arc(v.x, v.y, root.CubeArena.MELEE_REACH, a0, a1);
              g.lineStyle(0);
              if (engaged && c.meleeCd <= 0) {
                for (const aa of [a0, a1]) {
                  g.lineStyle(3, 0xffd166, 0.9);
                  g.moveTo(v.x + Math.cos(aa) * (root.CubeArena.MELEE_REACH - 10), v.y + Math.sin(aa) * (root.CubeArena.MELEE_REACH - 10));
                  g.lineTo(v.x + Math.cos(aa) * (root.CubeArena.MELEE_REACH + 4), v.y + Math.sin(aa) * (root.CubeArena.MELEE_REACH + 4));
                  g.lineStyle(0);
                }
              }
            }
          }
        }
      }
    }

    _drawFx() {
      const g = this.fxLayer;
      g.clear();

      // Melee swing arcs.
      for (const s of this.swings) {
        const k = 1 - s.life / s.max;
        const col = this._col(s.cube);
        g.lineStyle(6 * k, lighten(col, 80), 0.75 * k);
        g.arc(
          s.x,
          s.y,
          root.CubeArena.MELEE_REACH * (0.72 + 0.28 * (1 - k)),
          s.aim - root.CubeArena.MELEE_ARC / 2,
          s.aim + root.CubeArena.MELEE_ARC / 2
        );
        g.lineStyle(0);
      }

      // Particles.
      for (const p of this.particles) {
        const k = 1 - p.life / p.max;
        g.beginFill(p.color, 0.9 * k);
        g.drawCircle(p.x, p.y, p.r * k);
        g.endFill();
      }
    }

    _drawHud() {
      const g = this.hpBars;
      g.clear();
      const W = this.game.width;
      const MAXHP = root.CubeArena.MAX_HP;
      const barW = 300;
      const barH = 15;

      const drawBar = (x, y, frac, color, rightAlign) => {
        const bx = rightAlign ? x - barW : x;
        g.beginFill(0x151922, 0.9);
        g.drawRoundedRect(bx, y, barW, barH, 3);
        g.endFill();
        const w = Math.max(0, Math.min(1, frac)) * (barW - 4);
        if (w > 0) {
          g.beginFill(color, 1);
          if (rightAlign) g.drawRoundedRect(bx + (barW - 4 - w) + 2, y + 2, w, barH - 4, 2);
          else g.drawRoundedRect(bx + 2, y + 2, w, barH - 4, 2);
          g.endFill();
        }
        g.lineStyle(1, 0x2b3141, 1);
        g.drawRoundedRect(bx, y, barW, barH, 3);
        g.lineStyle(0);
      };

      // Left bar is always YOU (blue); right is always the opponent (red).
      // Online, HP comes from snapshot truth: local regen prediction runs a
      // tick ahead and made the numbers wobble ±1.
      const hpOf = (i) =>
        this.netMode && this._snapHp ? this._snapHp[i] : this.game.cubes[i].hp;
      const fMe = Math.max(0, hpOf(this.myIndex)) / MAXHP;
      const fFoe = Math.max(0, hpOf(1 - this.myIndex)) / MAXHP;
      drawBar(22, 32, fMe, fMe > 0.3 ? P1_COLOR : 0xff3b3b, false);
      drawBar(W - 22, 32, fFoe, fFoe > 0.3 ? P2_COLOR : 0xff3b3b, true);
      this.p1Hp.text = Math.ceil(hpOf(this.myIndex)) + " / " + MAXHP;
      this.p2Hp.text = Math.ceil(hpOf(1 - this.myIndex)) + " / " + MAXHP;

      // My cooldown pips.
      const me = this.game.cubes[this.myIndex];
      const cd = this.cdGfx;
      cd.clear();
      const pipW = 74;
      const pipH = 6;
      const gap = 18;
      const totalW = pipW * 3 + gap * 2;
      let px = W / 2 - totalW / 2;
      const py = 34;
      const pips = [
        { frac: 1 - me.dashCd / root.CubeArena.DASH_CD, color: 0x9ad9ff },
        { frac: 1 - me.meleeCd / root.CubeArena.MELEE_CD, color: 0xffc46b },
        { frac: 1 - me.shotCd / root.CubeArena.SHOT_CD, color: 0xbdf5a0 },
      ];
      for (const p of pips) {
        cd.beginFill(0x151922, 0.9);
        cd.drawRoundedRect(px, py, pipW, pipH, 3);
        cd.endFill();
        const f = Math.max(0, Math.min(1, p.frac));
        cd.beginFill(f >= 1 ? p.color : darken(p.color, 90), 1);
        cd.drawRoundedRect(px, py, pipW * f, pipH, 3);
        cd.endFill();
        px += pipW + gap;
      }

      // Round score: my wins always on the left.
      const wins = this.game.roundWins || [0, 0];
      this.scoreText.text = wins[this.myIndex] + "  \u2014  " + wins[1 - this.myIndex];

      // Ping (green under 70ms, amber under 140, red beyond).
      if (this.pingMs === null) {
        this.pingText.text = "LOCAL";
        this.pingText.style.fill = 0x5d6478;
      } else {
        this.pingText.text = "PING " + this.pingMs + "ms";
        this.pingText.style.fill =
          this.pingMs < 70 ? 0x52d16a : this.pingMs < 140 ? 0xffa63d : 0xff4d4d;
      }
    }

    // (The 3-2-1 countdown and matchup screens are DOM overlays owned by
    // main.js — fullscreen CSS animation beats canvas text for spectacle.)

    // Round banner: hands presentation to the DOM overlay (Champion-style
    // big score that increments), keeping only the screen shake here.
    // Throttled in case two sources fire in the same round.
    showRoundBanner(winner, wins) {
      const now = performance.now();
      if (now - this._lastRoundBannerAt < 1500) return;
      this._lastRoundBannerAt = now;
      this.shake = Math.max(this.shake, 10);
      if (root.CubeWarsRoundFX) {
        root.CubeWarsRoundFX({
          winner: winner,
          myIndex: this.myIndex,
          wins: wins ? wins.slice() : [0, 0],
        });
      }
    }

    showRoundStart(round) {
      // Cubes have just teleported home; the 3-2-1 supplies the hype.
      this._floater(this.game.width / 2, this.game.height / 2 - 130, "ROUND " + round, 0xffd166, 30);
    }

    // Server-truth hit feedback: called by the net layer when a snapshot shows
    // HP dropped without the local sim having predicted it. Guarantees the
    // victim flashes, sparks, and sounds on BOTH screens.
    showAuthoritativeHit(cubeId, dmg) {
      const c = this.game.cubes[cubeId];
      const v = this.view[cubeId];
      if (!c || !v) return;
      c.hitFlash = 0.16;
      this._spark(c.x, c.y, cubeId === this.myIndex ? 0xffb0b0 : 0xffd08a, 14, 260, 0.35);
      this._floater(c.x, c.y - 26, "-" + Math.round(dmg), cubeId === this.myIndex ? 0xff9a9a : 0xffc46b, 20);
      if (dmg >= 8) {
        Sfx.play("melee", 0.95 + Math.random() * 0.1);
        this.shake = Math.max(this.shake, cubeId === this.myIndex ? 14 : 8);
        this.hitStop = Math.max(this.hitStop, 0.04);
        v.squash = 1.1;
      } else {
        Sfx.play("wall", 1.5, 0.35);
        this.shake = Math.max(this.shake, 4);
      }
    }

    destroy() {
      try {
        this.app.ticker.remove(this._frame, this);
        this.app.destroy(true, { children: true, texture: true, baseTexture: true });
      } catch (e) {}
      if (this.mount) {
        while (this.mount.firstChild) this.mount.removeChild(this.mount.firstChild);
      }
    }
  }

  root.CubeArenaRender = { ArenaRenderer, Sfx, P1_COLOR, P2_COLOR };
})(typeof window !== "undefined" ? window : globalThis);
