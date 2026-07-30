// arenaEngine.js — Cube Wars real-time arena combat. Pure logic.
//
// No DOM, no Pixi, no timers. Advances only when you call step(), so the same
// code runs the client's prediction and the server's authority. Deterministic
// given identical inputs, which is what makes server-side validation (and
// therefore anti-cheat) possible.
//
// Combat is Minecraft-PvP-shaped: melee is the real damage but has reach and a
// swing cooldown, ranged is chip damage and zoning, and every hit applies
// knockback so positioning matters as much as aim.

(function (root) {
  "use strict";

  // --- world -----------------------------------------------------------------
  const ARENA_W = 1500;
  const ARENA_H = 880;
  const TICK_RATE = 32; // must match server.js
  const DT = 1 / TICK_RATE;

  // --- cube ------------------------------------------------------------------
  const CUBE_R = 19; // half-extent; collision treated as a circle
  const MAX_HP = 100;
  const ACCEL = 2100; // px/s^2 while holding a direction
  const FRICTION = 8.5; // per-second velocity decay
  const MAX_SPEED = 305;

  // --- dash ------------------------------------------------------------------
  const DASH_SPEED = 760;
  const DASH_TIME = 0.16; // seconds of dash movement
  const DASH_IFRAME = 0.18; // invulnerability window, slightly longer than the dash
  const DASH_CD = 1.15;
  // Dash is also an attack: slamming into the opponent mid-dash hits hard.
  const DASH_DMG = 8;
  const DASH_KNOCK = 560;

  // --- regen -----------------------------------------------------------------
  // Slow comeback mechanic: after a few clean seconds, HP trickles back. With
  // all damage halved, fights become longer and disengaging has real value.
  const REGEN_DELAY = 4; // seconds without taking damage
  const REGEN_RATE = 3.5; // hp per second

  // --- melee -----------------------------------------------------------------
  // Reach + arc rather than a hitbox: rewards facing and spacing. Generous on
  // purpose — whiffing constantly feels terrible in a fast duel.
  const MELEE_REACH = 92;
  const MELEE_ARC = Math.PI * 0.95; // ~171 degrees in front
  const MELEE_DMG = 9;
  const MELEE_CD = 0.52;
  const MELEE_WINDUP = 0.06; // brief tell before the hit lands
  const MELEE_KNOCK = 430;

  // --- ranged ----------------------------------------------------------------
  const SHOT_SPEED = 800;
  const SHOT_DMG = 3;
  const SHOT_CD = 0.17;
  const SHOT_LIFE = 1.35;
  const SHOT_R = 6;
  const SHOT_KNOCK = 90;

  // --- items -----------------------------------------------------------------
  // Items replace auto-apply powerups: walk over one to HOLD it (one at a
  // time), press E to use it, Q to drop it. Only one spawns on the map at once.
  const PU_R = 16;
  const ITEM_SPAWN_EVERY = 9; // seconds
  const ITEM_KINDS = ["medkit", "power", "overdrive", "aegis"];
  const ITEM_PICKUP_DELAY = 0.8; // dropped items can't be instantly regrabbed
  const MEDKIT_HEAL = 30;
  const BUFF_TIME = 6;
  const SHIELD_POOL = 40; // damage absorbed before it breaks

  // --- rounds ----------------------------------------------------------------
  // A match is FIRST TO 3 round wins. A KO ends the round; cubes respawn at
  // their starting spots after a short pause and fight again.
  const ROUND_WINS_NEEDED = 3;
  const ROUND_PAUSE = 4.3; // seconds between rounds: score beat + 3-2-1

  // --- terrain ---------------------------------------------------------------
  // Crates block movement and eat shots; generated from the match seed, so
  // every client and the server agree on the map.
  const OBSTACLE_COUNT = 5;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Shortest signed angle from a to b, so facing comparisons wrap correctly.
  function angleDiff(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  function makeCube(id, x, y, facing) {
    return {
      id: id,
      x: x,
      y: y,
      vx: 0,
      vy: 0,
      aim: facing, // radians, where the player is pointing
      hp: MAX_HP,
      alive: true,
      // timers, all in seconds and counted down
      dashT: 0,
      dashCd: 0,
      iframe: 0,
      meleeCd: 0,
      meleeWindup: 0,
      shotCd: 0,
      buffDmg: 0,
      buffSpeed: 0,
      buffRapid: 0,
      shield: 0, // remaining absorb pool from an aegis item
      item: null, // held item kind, or null
      lastDamagedAt: -999, // sim time of last damage taken, drives regen
      dashHit: false, // one slam per dash
      hitFlash: 0,
      // stats
      damageDealt: 0,
      hitsLanded: 0,
      shotsFired: 0,
    };
  }

  // An input frame. The client sends these; the server replays them.
  function makeInput() {
    return {
      up: false,
      down: false,
      left: false,
      right: false,
      aim: 0,
      shoot: false,
      melee: false,
      dash: false,
      useItem: false,
      dropItem: false,
    };
  }

  class ArenaGame {
    constructor(opts) {
      opts = opts || {};
      this.width = opts.width || ARENA_W;
      this.height = opts.height || ARENA_H;
      this.rng = makeRng(opts.seed === undefined ? 1 : opts.seed);
      this.tick = 0;
      this.time = 0;
      this.over = false;
      this.winner = null;
      this.round = 1;
      this.roundWins = [0, 0];
      this.roundPauseT = 0; // >0 = between rounds, gameplay suspended

      // Player 0 left-facing-right, player 1 right-facing-left.
      this.cubes = [
        makeCube(0, this.width * 0.22, this.height * 0.5, 0),
        makeCube(1, this.width * 0.78, this.height * 0.5, Math.PI),
      ];

      this.shots = [];
      this.powerups = [];
      this.puTimer = ITEM_SPAWN_EVERY * 0.6; // first one arrives a bit early
      this.nextShotId = 1;

      this.events = [];

      // Terrain comes from the seed, so all sides generate identical maps.
      this.obstacles = [];
      this._generateTerrain();
    }

    // Crates, placed away from spawns and from each other.
    _generateTerrain() {
      const cx = this.width / 2;
      const cy = this.height / 2;
      const spawnClear = 150; // keep spawn corridors open

      const clearOfSpawns = (x, y, r) => {
        for (const c of this.cubes) {
          if (Math.hypot(c.x - x, c.y - y) < r + spawnClear) return false;
        }
        return true;
      };

      for (let n = 0; n < OBSTACLE_COUNT; n++) {
        for (let attempt = 0; attempt < 40; attempt++) {
          const w = 55 + this.rng() * 70;
          const h = 55 + this.rng() * 70;
          const x = 100 + this.rng() * (this.width - 200 - w);
          const y = 80 + this.rng() * (this.height - 160 - h);
          const ccx = x + w / 2;
          const ccy = y + h / 2;
          if (!clearOfSpawns(ccx, ccy, Math.max(w, h) / 2)) continue;
          let ok = true;
          for (const o of this.obstacles) {
            if (
              x < o.x + o.w + 60 &&
              x + w + 60 > o.x &&
              y < o.y + o.h + 60 &&
              y + h + 60 > o.y
            )
              ok = false;
          }
          // Keep the centre circle open for duels.
          if (Math.hypot(ccx - cx, ccy - cy) < 130) ok = false;
          if (!ok) continue;
          // A visual style variant, so crates aren't all identical.
          this.obstacles.push({ x: x, y: y, w: w, h: h, style: n % 3 });
          break;
        }
      }
    }

    cube(i) {
      return this.cubes[i];
    }

    // Advance exactly one tick. inputs is [inputForCube0, inputForCube1].
    step(inputs) {
      if (this.over) return;
      this.tick++;
      this.time += DT;

      // Between rounds: time passes but nobody acts, then everyone respawns.
      if (this.roundPauseT > 0) {
        this.roundPauseT -= DT;
        if (this.roundPauseT <= 0) {
          this.roundPauseT = 0;
          this._respawnRound();
        }
        return;
      }

      for (let i = 0; i < 2; i++) {
        const c = this.cubes[i];
        if (!c.alive) continue;
        const inp = inputs[i] || makeInput();
        this._tickTimers(c);
        this._applyIntent(c, inp);
      }

      this._moveCubes();
      this._resolveCubeOverlap();
      this._moveShots();
      this._tickPowerups();
      this._checkKO();
    }

    _tickTimers(c) {
      c.dashT = Math.max(0, c.dashT - DT);
      c.dashCd = Math.max(0, c.dashCd - DT);
      c.iframe = Math.max(0, c.iframe - DT);
      c.meleeCd = Math.max(0, c.meleeCd - DT);
      c.shotCd = Math.max(0, c.shotCd - DT);
      c.buffDmg = Math.max(0, c.buffDmg - DT);
      c.buffSpeed = Math.max(0, c.buffSpeed - DT);
      c.buffRapid = Math.max(0, c.buffRapid - DT);
      c.hitFlash = Math.max(0, c.hitFlash - DT);

      // Autoregen: a clean stretch without taking damage slowly restores HP.
      if (c.alive && c.hp < MAX_HP && this.time - c.lastDamagedAt >= REGEN_DELAY) {
        c.hp = Math.min(MAX_HP, c.hp + REGEN_RATE * DT);
      }

      // Melee resolves after a short windup, so there's a readable tell.
      if (c.meleeWindup > 0) {
        c.meleeWindup -= DT;
        if (c.meleeWindup <= 0) {
          c.meleeWindup = 0;
          this._resolveMelee(c);
        }
      }
    }

    _applyIntent(c, inp) {
      c.aim = inp.aim;

      // Dash overrides normal steering while active.
      if (inp.dash && c.dashCd <= 0 && c.dashT <= 0) {
        let dx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
        let dy = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
        // Dash toward movement input, or toward aim when standing still.
        if (dx === 0 && dy === 0) {
          dx = Math.cos(c.aim);
          dy = Math.sin(c.aim);
        }
        const len = Math.hypot(dx, dy) || 1;
        c.vx = (dx / len) * DASH_SPEED;
        c.vy = (dy / len) * DASH_SPEED;
        c.dashT = DASH_TIME;
        c.dashCd = DASH_CD;
        c.iframe = DASH_IFRAME;
        c.dashHit = false; // fresh slam available
        this.events.push({ type: "dash", cube: c.id, x: c.x, y: c.y, dx: dx / len, dy: dy / len });
      }

      if (c.dashT <= 0) {
        const dx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
        const dy = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
        const cap = MAX_SPEED * (c.buffSpeed > 0 ? 1.45 : 1);

        const sp0 = Math.hypot(c.vx, c.vy);

        if (sp0 > cap) {
          // Above top speed means knockback is in play. Bleed it off with
          // friction instead of clamping, so getting hit actually launches you
          // even while you're holding a direction.
          const f = 1 - FRICTION * DT;
          c.vx *= f > 0 ? f : 0;
          c.vy *= f > 0 ? f : 0;
          // Steering authority while airborne-ish, but weak.
          if (dx !== 0 || dy !== 0) {
            const len = Math.hypot(dx, dy);
            c.vx += (dx / len) * ACCEL * 0.25 * DT;
            c.vy += (dy / len) * ACCEL * 0.25 * DT;
          }
        } else if (dx !== 0 || dy !== 0) {
          // Accelerate, then clamp. Friction is deliberately NOT applied here:
          // fighting the accel every tick pins top speed far below MAX_SPEED and
          // makes the cap dead code.
          const len = Math.hypot(dx, dy);
          c.vx += (dx / len) * ACCEL * DT;
          c.vy += (dy / len) * ACCEL * DT;
          const sp = Math.hypot(c.vx, c.vy);
          if (sp > cap) {
            c.vx = (c.vx / sp) * cap;
            c.vy = (c.vy / sp) * cap;
          }
        } else {
          // Coasting: friction brings you to a stop.
          const f = 1 - FRICTION * DT;
          c.vx *= f > 0 ? f : 0;
          c.vy *= f > 0 ? f : 0;
          if (Math.abs(c.vx) < 1) c.vx = 0;
          if (Math.abs(c.vy) < 1) c.vy = 0;
        }
      }

      if (inp.melee && c.meleeCd <= 0 && c.meleeWindup <= 0) {
        c.meleeCd = MELEE_CD;
        c.meleeWindup = MELEE_WINDUP;
        this.events.push({ type: "melee_swing", cube: c.id, x: c.x, y: c.y, aim: c.aim });
      }

      if (inp.shoot && c.shotCd <= 0) {
        // Overdrive cuts the cooldown.
        c.shotCd = SHOT_CD * (c.buffRapid > 0 ? 0.45 : 1);
        c.shotsFired++;
        const dmg = SHOT_DMG * (c.buffDmg > 0 ? 1.6 : 1);
        const nx = Math.cos(c.aim);
        const ny = Math.sin(c.aim);
        this.shots.push({
          id: this.nextShotId++,
          owner: c.id,
          x: c.x + nx * (CUBE_R + 6),
          y: c.y + ny * (CUBE_R + 6),
          vx: nx * SHOT_SPEED,
          vy: ny * SHOT_SPEED,
          life: SHOT_LIFE,
          dmg: dmg,
        });
        this.events.push({ type: "shoot", cube: c.id, x: c.x + nx * CUBE_R, y: c.y + ny * CUBE_R, aim: c.aim });
      }

      // Items: E uses the held one, Q drops it on the ground.
      if (inp.useItem && c.item) {
        const kind = c.item;
        c.item = null;
        if (kind === "medkit") c.hp = Math.min(MAX_HP, c.hp + MEDKIT_HEAL);
        else if (kind === "power") c.buffDmg = BUFF_TIME;
        else if (kind === "overdrive") {
          c.buffSpeed = BUFF_TIME;
          c.buffRapid = BUFF_TIME;
        } else if (kind === "aegis") c.shield = SHIELD_POOL;
        this.events.push({ type: "item_use", cube: c.id, kind: kind, x: c.x, y: c.y });
      }
      if (inp.dropItem && c.item) {
        this.powerups.push({
          x: c.x,
          y: c.y,
          kind: c.item,
          born: this.time,
          delay: ITEM_PICKUP_DELAY,
        });
        this.events.push({ type: "item_drop", cube: c.id, kind: c.item, x: c.x, y: c.y });
        c.item = null;
      }
    }

    _resolveMelee(c) {
      const other = this.cubes[1 - c.id];
      if (!other.alive) return;
      const dx = other.x - c.x;
      const dy = other.y - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist > MELEE_REACH + CUBE_R) {
        this.events.push({ type: "melee_whiff", cube: c.id, x: c.x, y: c.y, aim: c.aim });
        return;
      }
      // Must be roughly facing the target.
      const toTarget = Math.atan2(dy, dx);
      if (Math.abs(angleDiff(c.aim, toTarget)) > MELEE_ARC / 2) {
        this.events.push({ type: "melee_whiff", cube: c.id, x: c.x, y: c.y, aim: c.aim });
        return;
      }

      const dmg = MELEE_DMG * (c.buffDmg > 0 ? 1.6 : 1);
      const nx = dist > 0.001 ? dx / dist : Math.cos(c.aim);
      const ny = dist > 0.001 ? dy / dist : Math.sin(c.aim);
      this._damage(other, dmg, nx, ny, MELEE_KNOCK, c);
      this.events.push({
        type: "melee_hit",
        cube: c.id,
        target: other.id,
        x: other.x,
        y: other.y,
        dmg: dmg,
        blocked: other.iframe > 0,
      });
    }

    // Returns true if damage actually landed.
    _damage(target, dmg, nx, ny, knock, source) {
      if (!target.alive) return false;
      if (target.iframe > 0) return false; // dash i-frames negate the hit entirely

      // Shield soaks damage first (knockback still applies — you feel the hit).
      if (target.shield > 0) {
        const absorbed = Math.min(target.shield, dmg);
        target.shield -= absorbed;
        dmg -= absorbed;
        this.events.push({
          type: "shield_absorb",
          cube: target.id,
          x: target.x,
          y: target.y,
          broken: target.shield <= 0,
        });
      }

      target.hp = Math.max(0, target.hp - dmg);
      target.lastDamagedAt = this.time; // resets the regen clock
      target.vx += nx * knock;
      target.vy += ny * knock;
      target.hitFlash = 0.16;
      if (source) {
        source.damageDealt += dmg;
        source.hitsLanded++;
      }
      return true;
    }

    _moveCubes() {
      for (const c of this.cubes) {
        if (!c.alive) continue;
        c.x += c.vx * DT;
        c.y += c.vy * DT;

        // Walls bounce a little rather than hard-stopping: knockback into a wall
        // should feel like an impact, not a dead halt.
        if (c.x < CUBE_R) {
          c.x = CUBE_R;
          if (c.vx < 0) c.vx *= -0.32;
        } else if (c.x > this.width - CUBE_R) {
          c.x = this.width - CUBE_R;
          if (c.vx > 0) c.vx *= -0.32;
        }
        if (c.y < CUBE_R) {
          c.y = CUBE_R;
          if (c.vy < 0) c.vy *= -0.32;
        } else if (c.y > this.height - CUBE_R) {
          c.y = this.height - CUBE_R;
          if (c.vy > 0) c.vy *= -0.32;
        }

        this._collideObstacles(c);
      }
    }

    // Circle-vs-AABB: push the cube out along the shallowest axis and bounce
    // its velocity a little, same feel as the outer walls.
    _collideObstacles(c) {
      for (const o of this.obstacles) {
        const nearX = clamp(c.x, o.x, o.x + o.w);
        const nearY = clamp(c.y, o.y, o.y + o.h);
        const dx = c.x - nearX;
        const dy = c.y - nearY;
        const d2 = dx * dx + dy * dy;
        if (d2 >= CUBE_R * CUBE_R) continue;

        if (d2 > 0.0001) {
          // Corner contact: push out along the contact normal.
          const d = Math.sqrt(d2);
          const push = CUBE_R - d;
          c.x += (dx / d) * push;
          c.y += (dy / d) * push;
          // Kill velocity into the surface.
          const vn = (c.vx * dx + c.vy * dy) / d;
          if (vn < 0) {
            c.vx -= (dx / d) * vn * 1.32;
            c.vy -= (dy / d) * vn * 1.32;
          }
        } else {
          // Centre inside the box (deep overlap): resolve along shallowest axis.
          const left = c.x - o.x;
          const right = o.x + o.w - c.x;
          const top = c.y - o.y;
          const bottom = o.y + o.h - c.y;
          const m = Math.min(left, right, top, bottom);
          if (m === left) c.x = o.x - CUBE_R;
          else if (m === right) c.x = o.x + o.w + CUBE_R;
          else if (m === top) c.y = o.y - CUBE_R;
          else c.y = o.y + o.h + CUBE_R;
        }
      }
    }

    // Push cubes apart so they can't occupy the same space — and resolve dash
    // slams: touching the opponent mid-dash is a heavy hit. Dash-vs-dash means
    // both have i-frames, so they bounce off each other harmlessly.
    _resolveCubeOverlap() {
      const a = this.cubes[0];
      const b = this.cubes[1];
      if (!a.alive || !b.alive) return;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      const min = CUBE_R * 2 + 3; // slight grace so slams connect on touch
      if (d >= min || d === 0) return;
      const nx = dx / d;
      const ny = dy / d;

      for (const [attacker, victim, dir] of [
        [a, b, 1],
        [b, a, -1],
      ]) {
        if (attacker.dashT > 0 && !attacker.dashHit) {
          attacker.dashHit = true;
          const dmg = DASH_DMG * (attacker.buffDmg > 0 ? 1.6 : 1);
          const landed = this._damage(victim, dmg, nx * dir, ny * dir, DASH_KNOCK, attacker);
          this.events.push({
            type: "dash_hit",
            cube: attacker.id,
            target: victim.id,
            x: victim.x,
            y: victim.y,
            dmg: dmg,
            blocked: !landed,
          });
          // Slam recoil: the attacker rebounds a little instead of tunnelling.
          attacker.vx = -nx * dir * 180;
          attacker.vy = -ny * dir * 180;
        }
      }

      const push = (min - d) / 2;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
    }

    _moveShots() {
      for (let i = this.shots.length - 1; i >= 0; i--) {
        const s = this.shots[i];
        s.life -= DT;
        if (s.life <= 0) {
          this.shots.splice(i, 1);
          continue;
        }

        s.x += s.vx * DT;
        s.y += s.vy * DT;

        // Walls kill the shot.
        if (s.x < SHOT_R || s.x > this.width - SHOT_R || s.y < SHOT_R || s.y > this.height - SHOT_R) {
          this.events.push({ type: "shot_wall", x: s.x, y: s.y });
          this.shots.splice(i, 1);
          continue;
        }

        // Crates are cover — they eat shots.
        let blocked = false;
        for (const o of this.obstacles) {
          if (s.x > o.x - SHOT_R && s.x < o.x + o.w + SHOT_R && s.y > o.y - SHOT_R && s.y < o.y + o.h + SHOT_R) {
            blocked = true;
            break;
          }
        }
        if (blocked) {
          this.events.push({ type: "shot_wall", x: s.x, y: s.y });
          this.shots.splice(i, 1);
          continue;
        }

        const target = this.cubes[1 - s.owner];
        if (target.alive) {
          const dx = target.x - s.x;
          const dy = target.y - s.y;
          if (Math.hypot(dx, dy) < CUBE_R + SHOT_R) {
            const d = Math.hypot(dx, dy) || 1;
            const landed = this._damage(target, s.dmg, dx / d, dy / d, SHOT_KNOCK, this.cubes[s.owner]);
            this.events.push({
              type: "shot_hit",
              target: target.id,
              x: s.x,
              y: s.y,
              dmg: s.dmg,
              blocked: !landed,
            });
            this.shots.splice(i, 1);
          }
        }
      }
    }

    _tickPowerups() {
      // One item on the map at a time, counting both spawned and dropped ones.
      this.puTimer -= DT;
      if (this.puTimer <= 0 && this.powerups.length < 1) {
        this.puTimer = ITEM_SPAWN_EVERY;
        // Spawn away from the walls and not on top of a cube.
        const margin = 70;
        for (let attempt = 0; attempt < 16; attempt++) {
          const x = margin + this.rng() * (this.width - margin * 2);
          const y = margin + this.rng() * (this.height - margin * 2);
          let ok = true;
          for (const c of this.cubes) {
            if (Math.hypot(c.x - x, c.y - y) < 90) ok = false;
          }
          // Not inside cover, where it would be unreachable.
          for (const o of this.obstacles) {
            if (x > o.x - PU_R && x < o.x + o.w + PU_R && y > o.y - PU_R && y < o.y + o.h + PU_R) ok = false;
          }
          if (!ok) continue;
          const kind = ITEM_KINDS[Math.floor(this.rng() * ITEM_KINDS.length)];
          this.powerups.push({ x: x, y: y, kind: kind, born: this.time, delay: 0 });
          this.events.push({ type: "pu_spawn", x: x, y: y, kind: kind });
          break;
        }
      }

      // Pickup into the hand — never auto-applied, and only with a free hand.
      for (let i = this.powerups.length - 1; i >= 0; i--) {
        const p = this.powerups[i];
        if (this.time - p.born < (p.delay || 0)) continue; // freshly dropped
        for (const c of this.cubes) {
          if (!c.alive || c.item) continue;
          if (Math.hypot(c.x - p.x, c.y - p.y) > CUBE_R + PU_R) continue;
          c.item = p.kind;
          this.events.push({ type: "item_pickup", cube: c.id, kind: p.kind, x: p.x, y: p.y });
          this.powerups.splice(i, 1);
          break;
        }
      }
    }

    _checkKO() {
      for (const c of this.cubes) {
        if (c.alive && c.hp <= 0) {
          c.alive = false;
          this.events.push({ type: "ko", cube: c.id, x: c.x, y: c.y });
        }
      }
      if (this.over || this.roundPauseT > 0) return;
      const a = this.cubes[0].alive;
      const b = this.cubes[1].alive;
      if (a && b) return;

      // Round ends. Simultaneous shatter = nobody scores, replay the round.
      const roundWinner = !a && !b ? -1 : a ? 0 : 1;
      if (roundWinner !== -1) this.roundWins[roundWinner]++;
      if (roundWinner !== -1 && this.roundWins[roundWinner] >= ROUND_WINS_NEEDED) {
        this.over = true;
        this.winner = roundWinner;
        this.events.push({ type: "match_over", winner: this.winner, wins: this.roundWins.slice() });
      } else {
        this.events.push({
          type: "round_over",
          winner: roundWinner,
          wins: this.roundWins.slice(),
          round: this.round,
        });
        this.roundPauseT = ROUND_PAUSE;
      }
    }

    // Fresh round: cubes back at spawn with full HP; the board is swept of
    // shots and ground items. Held items carry over — banking one is strategy.
    _respawnRound() {
      this.round++;
      const spawns = [
        [this.width * 0.22, this.height * 0.5, 0],
        [this.width * 0.78, this.height * 0.5, Math.PI],
      ];
      for (let i = 0; i < 2; i++) {
        const c = this.cubes[i];
        c.x = spawns[i][0];
        c.y = spawns[i][1];
        c.aim = spawns[i][2];
        c.vx = 0;
        c.vy = 0;
        c.hp = MAX_HP;
        c.alive = true;
        c.dashT = 0;
        c.dashCd = 0;
        c.iframe = 0;
        c.meleeCd = 0;
        c.meleeWindup = 0;
        c.shotCd = 0;
        c.buffDmg = 0;
        c.buffSpeed = 0;
        c.buffRapid = 0;
        c.shield = 0;
        c.lastDamagedAt = -999;
        c.dashHit = false;
        c.hitFlash = 0;
      }
      this.shots = [];
      this.powerups = [];
      this.puTimer = ITEM_SPAWN_EVERY * 0.6;
      this.events.push({ type: "round_start", round: this.round, wins: this.roundWins.slice() });
    }

    drainEvents() {
      const e = this.events;
      this.events = [];
      return e;
    }

    // Compact authoritative state, for sending over the wire.
    snapshot() {
      return {
        tick: this.tick,
        over: this.over,
        winner: this.winner,
        round: this.round,
        roundWins: this.roundWins.slice(),
        roundPauseT: this.roundPauseT,
        cubes: this.cubes.map((c) => ({
          id: c.id,
          x: Math.round(c.x * 100) / 100,
          y: Math.round(c.y * 100) / 100,
          vx: Math.round(c.vx * 100) / 100,
          vy: Math.round(c.vy * 100) / 100,
          aim: Math.round(c.aim * 1000) / 1000,
          hp: c.hp,
          alive: c.alive,
          dashT: c.dashT,
          dashCd: c.dashCd,
          iframe: c.iframe,
          meleeCd: c.meleeCd,
          buffDmg: c.buffDmg,
          buffSpeed: c.buffSpeed,
          buffRapid: c.buffRapid,
          shield: c.shield,
          shotCd: c.shotCd,
          item: c.item,
          lastDamagedAt: c.lastDamagedAt,
        })),
        shots: this.shots.map((s) => ({
          id: s.id,
          owner: s.owner,
          x: Math.round(s.x * 10) / 10,
          y: Math.round(s.y * 10) / 10,
          vx: s.vx,
          vy: s.vy,
          dmg: s.dmg,
        })),
        powerups: this.powerups.map((p) => ({ x: p.x, y: p.y, kind: p.kind, delay: 0 })),
      };
    }

    // Overwrite local state from an authoritative snapshot (client reconcile).
    applySnapshot(s) {
      this.tick = s.tick;
      this.over = s.over;
      this.winner = s.winner;
      if (s.roundWins) {
        this.round = s.round;
        this.roundWins = s.roundWins.slice();
        this.roundPauseT = s.roundPauseT;
      }
      for (let i = 0; i < s.cubes.length; i++) {
        Object.assign(this.cubes[i], s.cubes[i]);
      }
      this.shots = s.shots.map((x) => Object.assign({ life: SHOT_LIFE }, x));
      this.powerups = s.powerups.map((p) => Object.assign({ born: this.time }, p));
    }
  }

  const api = {
    ArenaGame,
    makeInput,
    makeRng,
    TICK_RATE,
    DT,
    ARENA_W,
    ARENA_H,
    CUBE_R,
    MAX_HP,
    MELEE_REACH,
    MELEE_ARC,
    SHOT_R,
    PU_R,
    ITEM_KINDS,
    DASH_CD,
    MELEE_CD,
    SHOT_CD,
    DASH_DMG,
    MELEE_DMG,
    SHOT_DMG,
    SHIELD_POOL,
    MEDKIT_HEAL,
    REGEN_DELAY,
    REGEN_RATE,
    ROUND_WINS_NEEDED,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.CubeArena = api;
})(typeof window !== "undefined" ? window : globalThis);
