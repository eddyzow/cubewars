// Sanity checks for the Cube Wars arena engine. Run: npm test
const A = require("./docs/arenaEngine.js");
const { ArenaGame, makeInput, MAX_HP, CUBE_R, TICK_RATE } = A;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}
const idle = () => [makeInput(), makeInput()];
// Run n ticks with the given input for cube 0 only.
function run(g, n, inp0, inp1) {
  for (let i = 0; i < n; i++) g.step([inp0 || makeInput(), inp1 || makeInput()]);
}

console.log("\n== setup ==");
{
  const g = new ArenaGame({ seed: 1 });
  ok("two cubes", g.cubes.length === 2);
  ok("full hp", g.cubes[0].hp === MAX_HP && g.cubes[1].hp === MAX_HP);
  ok("both alive", g.cubes[0].alive && g.cubes[1].alive);
  ok("cubes separated", Math.abs(g.cubes[0].x - g.cubes[1].x) > CUBE_R * 4);
  ok("not over", g.over === false);
}

console.log("\n== movement ==");
{
  const g = new ArenaGame({ seed: 1 });
  const x0 = g.cubes[0].x;
  const inp = makeInput(); inp.right = true;
  run(g, 10, inp);
  ok("moves right when held", g.cubes[0].x > x0, x0 + " -> " + g.cubes[0].x);

  // Release and coast: friction must bring it to rest.
  run(g, 120, makeInput());
  ok("friction stops it", Math.hypot(g.cubes[0].vx, g.cubes[0].vy) < 5,
     "speed=" + Math.hypot(g.cubes[0].vx, g.cubes[0].vy).toFixed(2));
}

console.log("\n== speed cap ==");
{
  const g = new ArenaGame({ seed: 1 });
  const inp = makeInput(); inp.right = true; inp.down = true;
  run(g, 200, inp);
  const sp = Math.hypot(g.cubes[0].vx, g.cubes[0].vy);
  ok("diagonal is not faster than cap", sp <= A.CUBE_R * 0 + 306, "speed=" + sp.toFixed(1));
}

console.log("\n== walls ==");
{
  const g = new ArenaGame({ seed: 1 });
  const inp = makeInput(); inp.left = true;
  run(g, 300, inp);
  ok("stays inside left wall", g.cubes[0].x >= CUBE_R - 0.01, "x=" + g.cubes[0].x.toFixed(2));
  const g2 = new ArenaGame({ seed: 1 });
  const up = makeInput(); up.up = true;
  run(g2, 300, up);
  ok("stays inside top wall", g2.cubes[0].y >= CUBE_R - 0.01, "y=" + g2.cubes[0].y.toFixed(2));
}

console.log("\n== dash ==");
{
  const g = new ArenaGame({ seed: 1 });
  const inp = makeInput(); inp.dash = true; inp.right = true;
  g.step([inp, makeInput()]);
  ok("dash grants iframames", g.cubes[0].iframe > 0);
  ok("dash sets cooldown", g.cubes[0].dashCd > 0);
  const fastSpeed = Math.hypot(g.cubes[0].vx, g.cubes[0].vy);
  ok("dash is faster than walking", fastSpeed > 400, "speed=" + fastSpeed.toFixed(0));

  // Cannot dash again while on cooldown.
  const cdBefore = g.cubes[0].dashCd;
  g.step([inp, makeInput()]);
  ok("cannot re-dash during cd", g.cubes[0].dashCd <= cdBefore);
}

console.log("\n== dash iframes negate damage ==");
{
  const g = new ArenaGame({ seed: 1 });
  // Put them adjacent, cube0 facing cube1.
  g.cubes[0].x = 400; g.cubes[0].y = 300;
  g.cubes[1].x = 440; g.cubes[1].y = 300;
  g.cubes[1].iframe = 0.2; // target is dashing
  const inp = makeInput(); inp.melee = true; inp.aim = 0;
  run(g, 6, inp);
  ok("iframe target takes no damage", g.cubes[1].hp === MAX_HP, "hp=" + g.cubes[1].hp);
}

console.log("\n== melee: reach and facing ==");
{
  // In range and facing -> hit.
  const g = new ArenaGame({ seed: 1 });
  g.cubes[0].x = 400; g.cubes[0].y = 300;
  g.cubes[1].x = 445; g.cubes[1].y = 300;
  const inp = makeInput(); inp.melee = true; inp.aim = 0; // facing +x
  run(g, 6, inp);
  ok("melee hits in range + facing", g.cubes[1].hp < MAX_HP, "hp=" + g.cubes[1].hp);

  // In range but facing away -> whiff.
  const g2 = new ArenaGame({ seed: 1 });
  g2.cubes[0].x = 400; g2.cubes[0].y = 300;
  g2.cubes[1].x = 445; g2.cubes[1].y = 300;
  const away = makeInput(); away.melee = true; away.aim = Math.PI; // facing -x
  run(g2, 6, away);
  ok("melee whiffs when facing away", g2.cubes[1].hp === MAX_HP, "hp=" + g2.cubes[1].hp);

  // Out of range -> whiff.
  const g3 = new ArenaGame({ seed: 1 });
  g3.cubes[0].x = 200; g3.cubes[0].y = 300;
  g3.cubes[1].x = 600; g3.cubes[1].y = 300;
  const far = makeInput(); far.melee = true; far.aim = 0;
  run(g3, 6, far);
  ok("melee whiffs out of range", g3.cubes[1].hp === MAX_HP, "hp=" + g3.cubes[1].hp);
}

console.log("\n== melee knockback + cooldown ==");
{
  const g = new ArenaGame({ seed: 1 });
  g.cubes[0].x = 400; g.cubes[0].y = 300;
  g.cubes[1].x = 445; g.cubes[1].y = 300;
  const inp = makeInput(); inp.melee = true; inp.aim = 0;
  run(g, 6, inp);
  ok("knockback pushes target away", g.cubes[1].x > 445, "x=" + g.cubes[1].x.toFixed(1));
  ok("melee has cooldown", g.cubes[0].meleeCd > 0);

  const hpAfterFirst = g.cubes[1].hp;
  // Immediately try again; cooldown should prevent a second hit this instant.
  g.step([inp, makeInput()]);
  ok("cannot melee twice instantly", g.cubes[1].hp === hpAfterFirst,
     hpAfterFirst + " vs " + g.cubes[1].hp);
}

console.log("\n== ranged ==");
{
  const g = new ArenaGame({ seed: 1 });
  g.cubes[0].x = 200; g.cubes[0].y = 300; g.cubes[1].x = 600; g.cubes[1].y = 300;
  const inp = makeInput(); inp.shoot = true; inp.aim = 0;
  g.step([inp, makeInput()]);
  ok("shot spawned", g.shots.length === 1);
  ok("shot has owner", g.shots[0].owner === 0);
  ok("shot cooldown set", g.cubes[0].shotCd > 0);

  // Let it travel; it should hit cube1.
  run(g, 40, makeInput());
  ok("shot damages target", g.cubes[1].hp < MAX_HP, "hp=" + g.cubes[1].hp);
  ok("shot consumed on hit", g.shots.length === 0);
}

console.log("\n== shot dies on wall ==");
{
  const g = new ArenaGame({ seed: 1 });
  g.cubes[0].x = 100; g.cubes[0].y = 300;
  g.cubes[1].x = 800; g.cubes[1].y = 50; // out of the way
  const inp = makeInput(); inp.shoot = true; inp.aim = Math.PI; // fire at left wall
  g.step([inp, makeInput()]);
  ok("shot exists", g.shots.length === 1);
  run(g, 40, makeInput());
  ok("shot removed at wall", g.shots.length === 0);
}

console.log("\n== shot does not hit its owner ==");
{
  const g = new ArenaGame({ seed: 1 });
  g.cubes[0].x = 400; g.cubes[0].y = 300;
  g.cubes[1].x = 850; g.cubes[1].y = 600;
  const inp = makeInput(); inp.shoot = true; inp.aim = 0;
  g.step([inp, makeInput()]);
  const hp0 = g.cubes[0].hp;
  run(g, 3, makeInput());
  ok("owner unharmed by own shot", g.cubes[0].hp === hp0);
}

console.log("\n== cubes cannot overlap ==");
{
  const g = new ArenaGame({ seed: 1 });
  g.cubes[0].x = 400; g.cubes[0].y = 300;
  g.cubes[1].x = 405; g.cubes[1].y = 300;
  g.step(idle());
  const d = Math.hypot(g.cubes[1].x - g.cubes[0].x, g.cubes[1].y - g.cubes[0].y);
  ok("separated to >= 2r", d >= CUBE_R * 2 - 0.5, "dist=" + d.toFixed(2));
}

console.log("\n== rounds: KO ends the ROUND, first to 3 ends the MATCH ==");
{
  const g = new ArenaGame({ seed: 1 });
  g.obstacles = [];
  const koCube1 = () => {
    g.cubes[1].hp = 1; g.cubes[1].iframe = 0; g.cubes[1].shield = 0;
    g.cubes[0].x = 400; g.cubes[0].y = 300; g.cubes[0].meleeCd = 0; g.cubes[0].meleeWindup = 0;
    g.cubes[1].x = 445; g.cubes[1].y = 300;
    const inp = makeInput(); inp.melee = true; inp.aim = 0;
    run(g, 6, inp);
  };

  koCube1();
  ok("round 1 KO does not end match", g.over === false);
  ok("round win recorded 1-0", g.roundWins[0] === 1 && g.roundWins[1] === 0,
     g.roundWins.join("-"));
  ok("inter-round pause active", g.roundPauseT > 0);

  // Ride out the pause -> respawn.
  run(g, TICK_RATE * 5, makeInput());
  ok("cubes respawned alive at full hp",
     g.cubes[1].alive && g.cubes[1].hp === MAX_HP && g.cubes[0].hp === MAX_HP);
  ok("round counter advanced", g.round === 2, "round=" + g.round);
  ok("board swept of shots/items", g.shots.length === 0 && g.powerups.length === 0);

  koCube1();
  run(g, TICK_RATE * 5, makeInput());
  ok("2-0 after second KO", g.roundWins[0] === 2, g.roundWins.join("-"));

  koCube1();
  ok("third KO ends the match", g.over === true);
  ok("winner is cube 0", g.winner === 0, "winner=" + g.winner);

  const tickBefore = g.tick;
  g.step(idle());
  ok("step is noop after over", g.tick === tickBefore);
}

console.log("\n== item spawning ==");
{
  const g = new ArenaGame({ seed: 9 });
  run(g, TICK_RATE * 12, makeInput());
  ok("an item spawned", g.powerups.length >= 1, "count=" + g.powerups.length);
  ok("never more than one on the map", g.powerups.length <= 1, "count=" + g.powerups.length);

  // Speed buff via overdrive contact raises the cap.
  const g4 = new ArenaGame({ seed: 9 });
  g4.obstacles = [];
  g4.powerups.push({ x: g4.cubes[0].x, y: g4.cubes[0].y, kind: "overdrive", born: 0 });
  g4.step([makeInput(), makeInput()]);
  ok("overdrive buffs speed + fire rate", g4.cubes[0].buffSpeed > 0 && g4.cubes[0].buffRapid > 0);
  const fast = makeInput(); fast.right = true;
  run(g4, 100, fast);
  ok("buffed speed exceeds base cap", Math.hypot(g4.cubes[0].vx, g4.cubes[0].vy) > 310,
     "speed=" + Math.hypot(g4.cubes[0].vx, g4.cubes[0].vy).toFixed(0));
}

console.log("\n== speed cap is the real governor (regression) ==");
{
  // Friction applied during acceleration used to pin top speed at ~181, making
  // MAX_SPEED dead code and the speed buff a no-op.
  const g = new ArenaGame({ seed: 9 });
  const inp = makeInput(); inp.right = true;
  run(g, 150, inp);
  const sp = Math.hypot(g.cubes[0].vx, g.cubes[0].vy);
  ok("reaches intended top speed ~305", sp > 300 && sp < 310, "speed=" + sp.toFixed(1));
}

console.log("\n== knockback survives held input (regression) ==");
{
  // Clamping unconditionally used to erase knockback whenever the victim held a
  // movement key, which killed the impact of melee.
  const g = new ArenaGame({ seed: 9 });
  g.cubes[0].vx = 900;
  const hold = makeInput(); hold.right = true;
  g.step([hold, makeInput()]);
  ok("knockback not instantly clamped", g.cubes[0].vx > 500, "vx=" + g.cubes[0].vx.toFixed(0));
  run(g, 30, hold);
  ok("knockback decays back to cap", Math.abs(g.cubes[0].vx - 305) < 6, "vx=" + g.cubes[0].vx.toFixed(1));
}

console.log("\n== v2: dash slam ==");
{
  const g = new ArenaGame({ seed: 1 });
  g.obstacles = []; // isolate from terrain
  g.cubes[0].x = 400; g.cubes[0].y = 300;
  g.cubes[1].x = 470; g.cubes[1].y = 300;
  const inp = makeInput(); inp.dash = true; inp.right = true;
  run(g, 4, inp);
  ok("dash into opponent deals damage", g.cubes[1].hp < MAX_HP, "hp=" + g.cubes[1].hp);
  ok("slam knocks target away", g.cubes[1].x > 470, "x=" + g.cubes[1].x.toFixed(0));

  // Only one slam per dash.
  const hpAfter = g.cubes[1].hp;
  run(g, 2, inp);
  ok("one slam per dash", g.cubes[1].hp === hpAfter, hpAfter + " vs " + g.cubes[1].hp);
}

console.log("\n== v2: dash vs dash bounces harmlessly ==");
{
  const g = new ArenaGame({ seed: 1 });
  g.obstacles = [];
  g.cubes[0].x = 400; g.cubes[0].y = 300;
  g.cubes[1].x = 480; g.cubes[1].y = 300;
  const a = makeInput(); a.dash = true; a.right = true;
  const b = makeInput(); b.dash = true; b.left = true;
  run(g, 5, a, b);
  ok("no damage either way", g.cubes[0].hp === MAX_HP && g.cubes[1].hp === MAX_HP,
     g.cubes[0].hp + "/" + g.cubes[1].hp);
}

console.log("\n== v2: obstacles ==");
{
  const g = new ArenaGame({ seed: 2 });
  g.obstacles = [{ x: 500, y: 250, w: 100, h: 100 }];
  // Cube cannot pass through.
  g.cubes[0].x = 450; g.cubes[0].y = 300;
  g.cubes[1].x = 1200; g.cubes[1].y = 700;
  const inp = makeInput(); inp.right = true;
  run(g, 60, inp);
  ok("cube blocked by crate", g.cubes[0].x < 500, "x=" + g.cubes[0].x.toFixed(0));

  // Shots die on crates — always, no exceptions.
  const g2 = new ArenaGame({ seed: 2 });
  g2.obstacles = [{ x: 500, y: 250, w: 100, h: 100 }];
  g2.cubes[0].x = 400; g2.cubes[0].y = 300;
  g2.cubes[1].x = 800; g2.cubes[1].y = 300;
  const shootInp = makeInput(); shootInp.shoot = true; shootInp.aim = 0;
  g2.step([shootInp, makeInput()]);
  run(g2, 40, makeInput());
  ok("crate blocks shot", g2.cubes[1].hp === MAX_HP, "hp=" + g2.cubes[1].hp);
}

console.log("\n== v3: items apply instantly on contact ==");
{
  const g = new ArenaGame({ seed: 3 });
  g.obstacles = [];
  g.powerups.push({ x: g.cubes[1].x, y: g.cubes[1].y, kind: "aegis", born: 0 });
  g.step(idle());
  ok("aegis applies on walk-over", g.cubes[1].shield === A.SHIELD_POOL, "shield=" + g.cubes[1].shield);
  ok("item consumed", g.powerups.length === 0);

  const g2 = new ArenaGame({ seed: 3 });
  g2.obstacles = [];
  g2.powerups.push({ x: g2.cubes[0].x, y: g2.cubes[0].y, kind: "overdrive", born: 0 });
  g2.step(idle());
  ok("overdrive applies on contact", g2.cubes[0].buffSpeed > 0 && g2.cubes[0].buffRapid > 0);
}

console.log("\n== v3: medkit heals on contact ==");
{
  const g = new ArenaGame({ seed: 3 });
  g.obstacles = [];
  g.cubes[0].hp = 40;
  g.cubes[0].lastDamagedAt = g.time; // suppress regen for a clean reading
  g.powerups.push({ x: g.cubes[0].x, y: g.cubes[0].y, kind: "medkit", born: 0 });
  g.step([makeInput(), makeInput()]);
  ok("medkit heals " + A.MEDKIT_HEAL, Math.abs(g.cubes[0].hp - (40 + A.MEDKIT_HEAL)) < 1,
     "hp=" + g.cubes[0].hp);
}

console.log("\n== v3: autoregen ==");
{
  const g = new ArenaGame({ seed: 3 });
  g.obstacles = [];
  g.cubes[0].hp = 50;
  g.cubes[0].lastDamagedAt = g.time;
  // Before the delay: no regen.
  run(g, Math.floor(TICK_RATE * (A.REGEN_DELAY - 0.5)), makeInput());
  ok("no regen before delay", g.cubes[0].hp <= 50.2, "hp=" + g.cubes[0].hp.toFixed(1));
  // After the delay: hp climbs at ~REGEN_RATE.
  run(g, TICK_RATE * 2, makeInput());
  ok("regen kicks in after delay", g.cubes[0].hp > 53, "hp=" + g.cubes[0].hp.toFixed(1));
  // Taking damage resets the clock.
  g.cubes[0].hp = 50;
  g._damage(g.cubes[0], 1, 1, 0, 0, null);
  const hpAfterHit = g.cubes[0].hp;
  run(g, TICK_RATE * 2, makeInput());
  ok("damage resets regen clock", g.cubes[0].hp <= hpAfterHit + 0.2, "hp=" + g.cubes[0].hp.toFixed(1));
}

console.log("\n== v3: halved damage values ==");
{
  ok("shot dmg 3", A.SHOT_DMG === 3, A.SHOT_DMG);
  ok("melee dmg 9", A.MELEE_DMG === 9, A.MELEE_DMG);
  ok("dash dmg 8", A.DASH_DMG === 8, A.DASH_DMG);
}

console.log("\n== v2: rapid fire ==");
{
  const g = new ArenaGame({ seed: 4 });
  g.obstacles = [];
  const fire = makeInput(); fire.shoot = true; fire.aim = Math.PI / 2; // harmless direction
  const count = (game) => { let n=0; const i2=Object.assign(makeInput(), fire); for(let t=0;t<32;t++){ game.step([i2, makeInput()]); } return game.cubes[0].shotsFired; };
  const normal = count(g);
  const g2 = new ArenaGame({ seed: 4 });
  g2.obstacles = [];
  g2.cubes[0].buffRapid = 10;
  const rapid = count(g2);
  ok("rapid fires ~2x faster", rapid > normal * 1.6, normal + " -> " + rapid);
}

console.log("\n== v2: terrain determinism ==");
{
  const g1 = new ArenaGame({ seed: 555 });
  const g2 = new ArenaGame({ seed: 555 });
  ok("same seed -> same obstacles", JSON.stringify(g1.obstacles) === JSON.stringify(g2.obstacles));
  ok("terrain generated with style variants", g1.obstacles.length > 0 && g1.obstacles.every(o => o.style !== undefined),
     g1.obstacles.length + " crates");
  const g3 = new ArenaGame({ seed: 556 });
  ok("different seed -> different terrain", JSON.stringify(g1.obstacles) !== JSON.stringify(g3.obstacles));
}

console.log("\n== determinism (critical for server validation) ==");
{
  const mk = () => {
    const g = new ArenaGame({ seed: 4242 });
    for (let i = 0; i < 200; i++) {
      const a = makeInput();
      // Deterministic but varied input pattern.
      a.right = i % 3 === 0; a.up = i % 5 === 0; a.shoot = i % 7 === 0;
      a.melee = i % 11 === 0; a.dash = i % 29 === 0; a.aim = (i % 360) * Math.PI / 180;
      const b = makeInput();
      b.left = i % 4 === 0; b.down = i % 6 === 0; b.shoot = i % 9 === 0;
      g.step([a, b]);
    }
    return g;
  };
  const g1 = mk();
  const g2 = mk();
  ok("identical snapshots from same seed+inputs",
     JSON.stringify(g1.snapshot()) === JSON.stringify(g2.snapshot()));

  const g3 = new ArenaGame({ seed: 777 });
  for (let i = 0; i < 200; i++) g3.step(idle());
  const g4 = new ArenaGame({ seed: 778 });
  for (let i = 0; i < 200; i++) g4.step(idle());
  ok("different seeds diverge (powerup placement)",
     JSON.stringify(g3.powerups) !== JSON.stringify(g4.powerups));
}

console.log("\n== snapshot round-trip (client reconcile) ==");
{
  const g = new ArenaGame({ seed: 11 });
  const inp = makeInput(); inp.right = true; inp.shoot = true; inp.aim = 0.5;
  run(g, 30, inp);
  const snap = g.snapshot();

  const clone = new ArenaGame({ seed: 11 });
  clone.applySnapshot(snap);
  ok("tick restored", clone.tick === g.tick);
  ok("hp restored", clone.cubes[1].hp === g.cubes[1].hp);
  ok("positions restored", Math.abs(clone.cubes[0].x - g.cubes[0].x) < 0.02);
  ok("shots restored", clone.shots.length === g.shots.length);
}

console.log("\n== events emitted ==");
{
  const g = new ArenaGame({ seed: 1 });
  g.cubes[0].x = 400; g.cubes[0].y = 300;
  g.cubes[1].x = 445; g.cubes[1].y = 300;
  const inp = makeInput(); inp.melee = true; inp.shoot = true; inp.dash = true; inp.aim = 0;
  run(g, 8, inp);
  const types = g.drainEvents().map(e => e.type);
  ok("emits dash", types.includes("dash"), types.join(","));
  ok("emits shoot", types.includes("shoot"));
  ok("emits melee_swing", types.includes("melee_swing"));
  ok("drained twice is empty", g.drainEvents().length === 0);
}

console.log("\n" + (fail === 0 ? "ALL PASS" : fail + " FAILURE(S)") + "  (" + pass + " passed)\n");
process.exit(fail === 0 ? 0 : 1);
