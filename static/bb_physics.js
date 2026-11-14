/**
 * BattleBot Designer v2 — parts catalog + engineering model.
 *
 * The build is a graph: a chassis exposes five hardpoints (front / top / rear / left / right),
 * any module can be bolted to any hardpoint, and every powered module hangs off the same
 * battery bus. Nothing is blocked; the engineering checks tell you what the combination costs.
 *
 * Pure data and math (no DOM, no THREE) so it runs in Node for testing. Internal units are SI.
 * Catalog entries are REPRESENTATIVE component classes, not datasheet values for real products.
 * Thermal / electrical / projectile modules use simplified, game-level models.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BBPhysics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const G = 9.81;
  const KG_TO_LB = 2.20462;
  const MS_TO_MPH = 2.23694;
  const M_TO_IN = 39.3701;
  const N_TO_LBF = 0.224809;
  const RHO_STEEL = 7850;
  const RHO_AL = 2700;
  const RHO_AIR = 1.2;
  // weightLb is the heavyweight reference the model is computed in; smaller classes are dynamically similar
  // scale models of it (see CLASSES / scaleText).
  const LIMITS = { weightLb: 250, tipMph: 250, matchSeconds: 180 };
  const CLASSES = {
    ant: { name: 'ANTWEIGHT', lb: 1 }, beetle: { name: 'BEETLEWEIGHT', lb: 3 }, hobby: { name: 'HOBBYWEIGHT', lb: 12 }, feather: { name: 'FEATHERWEIGHT', lb: 30 },
    light: { name: 'LIGHTWEIGHT', lb: 60 }, middle: { name: 'MIDDLEWEIGHT', lb: 120 }, heavy: { name: 'HEAVYWEIGHT', lb: 250 },
  };
  const SLOTS = ['front', 'top', 'rear', 'left', 'right'];
  const SLOT_NAMES = { front: 'FRONT', top: 'TOP', rear: 'REAR', left: 'LEFT', right: 'RIGHT' };

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const f = (v, d) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });

  // ---------------------------------------------------------------------------
  // CATALOG
  // ---------------------------------------------------------------------------
  const MATERIALS = {
    ar500: { name: 'AR500 STEEL', rho: 7850, yieldMPa: 1250, note: 'ABRASION-RESISTANT PLATE' },
    hardox: { name: 'HARDOX 450', rho: 7850, yieldMPa: 1200, note: 'WEAR PLATE' },
    mild: { name: 'A36 MILD STEEL', rho: 7850, yieldMPa: 250, note: 'CHEAP AND WELDABLE' },
    ti: { name: 'GRADE 5 TITANIUM', rho: 4430, yieldMPa: 880, note: 'Ti-6Al-4V' },
    al7075: { name: '7075-T6 ALUMINUM', rho: 2810, yieldMPa: 500, note: 'AEROSPACE BILLET' },
    cfrp: { name: 'CARBON FIBRE', rho: 1600, yieldMPa: 600, note: 'STIFF, BRITTLE LAMINATE' },
    uhmw: { name: 'UHMW-PE', rho: 940, yieldMPa: 22, note: 'ABLATIVE POLYMER' },
  };

  // shape drives both the layout rules and the 3D frame builder
  const CHASSIS = {
    box: { name: '4WD BILLET BOX', desc: 'LOW POCKETED TUB', shape: 'box', L: 0.86, W: 0.72, H: 0.17, wheels: 4, wallT: 0.0127, baseT: 0.0048, pocket: 0.7 },
    compact: { name: '2WD COMPACT', desc: 'SHORT MONOCOQUE', shape: 'box', L: 0.66, W: 0.64, H: 0.18, wheels: 2, wallT: 0.0159, baseT: 0.0048, pocket: 0.72 },
    wedge: { name: '4WD WEDGE', desc: 'SLOPED NOSE', shape: 'wedge', L: 0.92, W: 0.74, H: 0.18, wheels: 4, wallT: 0.0127, baseT: 0.0048, pocket: 0.7 },
    sixwd: { name: '6WD LONGBODY', desc: 'SIX DRIVEN WHEELS', shape: 'box', L: 1.08, W: 0.68, H: 0.16, wheels: 6, wallT: 0.0127, baseT: 0.0048, pocket: 0.68 },
    hex: { name: 'OCTAGON', desc: 'EIGHT-SIDED INVERTIBLE HULL', shape: 'hex', L: 0.8, W: 0.8, H: 0.15, wheels: 4, wallT: 0.0127, baseT: 0.0048, pocket: 0.7 },
    tube: { name: 'TUBE SPACEFRAME', desc: '4130 CHROMOLY CAGE', shape: 'tube', L: 0.74, W: 0.7, H: 0.18, wheels: 2, tubeKgPerM: 1.55, baseT: 0.0032 },
    bigwheel: { name: 'BIG-WHEEL POD', desc: 'NARROW POD, OUTBOARD WHEELS', shape: 'bigwheel', L: 0.5, W: 0.86, H: 0.16, wheels: 2, wallT: 0.0127, baseT: 0.0048, pocket: 0.72 },
    round: { name: 'ROUND PEDESTAL', desc: 'DISC BASE + POSTS', shape: 'round', L: 0.68, W: 0.68, H: 0.18, R: 0.34, wheels: 2, baseT: 0.008 },
    dog: { name: 'QUADRUPED K9', desc: 'FOUR-LEGGED WALKER', shape: 'dog', L: 0.78, W: 0.42, H: 0.16, wheels: 0, legs: 4, wallT: 0.0127, baseT: 0.0048, pocket: 0.7 },
    hexapod: { name: 'HEXAPOD', desc: 'SIX-LEGGED WALKER', shape: 'dog', L: 0.9, W: 0.44, H: 0.16, wheels: 0, legs: 6, wallT: 0.0127, baseT: 0.0048, pocket: 0.7 },
    tracked: { name: 'TRACKED CRAWLER', desc: 'TWIN RUBBER TRACKS', shape: 'box', L: 0.84, W: 0.74, H: 0.17, wheels: 4, tracks: true, wallT: 0.0127, baseT: 0.0048, pocket: 0.7 },
    tri: { name: 'THREE-WHEELER', desc: 'TWO DRIVEN WHEELS + CASTER', shape: 'box', L: 0.62, W: 0.62, H: 0.16, wheels: 2, caster: true, wallT: 0.0127, baseT: 0.0048, pocket: 0.72 },
    pancake: { name: 'PANCAKE', desc: 'ULTRA-LOW INVERTIBLE SLAB', shape: 'box', L: 0.9, W: 0.78, H: 0.105, wheels: 4, wallT: 0.0127, baseT: 0.0048, pocket: 0.7 },
    delta: { name: 'DELTA', desc: 'TRIANGULAR HULL, REAR WHEELS', shape: 'delta', L: 0.86, W: 0.84, H: 0.16, wheels: 2, wallT: 0.0127, baseT: 0.0048, pocket: 0.72 },
    ushape: { name: 'U-FRAME', desc: 'OPEN WEAPON BAY BETWEEN PRONGS', shape: 'ushape', L: 0.92, W: 0.78, H: 0.17, wheels: 4, wallT: 0.0127, baseT: 0.0048, pocket: 0.7 },
    hframe: { name: 'H-FRAME', desc: 'TWIN PODS + CENTRE BRIDGE', shape: 'hframe', L: 0.94, W: 0.8, H: 0.17, wheels: 4, wallT: 0.0127, baseT: 0.0048, pocket: 0.7 },
    puck: { name: 'MELTY PUCK', desc: 'COMPACT ROUND TWO-WHEELER', shape: 'round', L: 0.52, W: 0.52, H: 0.15, R: 0.26, wheels: 2, baseT: 0.008 },
  };

  // kv rpm/V, r ohm, iMax burst amps
  const WEAPON_MOTORS = {
    wm_s: { name: '63 MM OUTRUNNER', kv: 190, r: 0.020, iMax: 150, kg: 0.9, d: 0.063, l: 0.075 },
    wm_m: { name: '80 MM OUTRUNNER', kv: 130, r: 0.014, iMax: 250, kg: 1.9, d: 0.08, l: 0.09 },
    wm_l: { name: '120 MM OUTRUNNER', kv: 100, r: 0.008, iMax: 400, kg: 4.2, d: 0.12, l: 0.11 },
    wm_xl: { name: '150 MM OUTRUNNER', kv: 62, r: 0.006, iMax: 600, kg: 8.6, d: 0.15, l: 0.13 },
    wm_b: { name: 'BRUSHED 4.5 IN PM', kv: 110, r: 0.03, iMax: 300, kg: 6.4, d: 0.115, l: 0.17 },
  };
  const DRIVE_MOTORS = {
    dm_s: { name: '50 MM OUTRUNNER', kv: 270, r: 0.030, iMax: 90, kg: 0.45, d: 0.05, l: 0.06 },
    dm_m: { name: '63 MM OUTRUNNER', kv: 190, r: 0.020, iMax: 140, kg: 0.9, d: 0.063, l: 0.075 },
    dm_l: { name: '80 MM OUTRUNNER', kv: 130, r: 0.014, iMax: 220, kg: 1.9, d: 0.08, l: 0.09 },
    dm_xl: { name: '100 MM OUTRUNNER', kv: 100, r: 0.010, iMax: 300, kg: 3.1, d: 0.1, l: 0.1 },
    dm_b: { name: 'BRUSHED GEARMOTOR', kv: 140, r: 0.05, iMax: 120, kg: 2.2, d: 0.08, l: 0.12 },
  };
  const ESCS = {
    esc_80: { name: '80 A / 8S ESC', cont: 80, maxS: 8, kg: 0.12, r: 0.003, dims: [0.07, 0.02, 0.035] },
    esc_160: { name: '160 A / 12S ESC', cont: 160, maxS: 12, kg: 0.35, r: 0.002, dims: [0.11, 0.03, 0.06] },
    esc_300: { name: '300 A / 14S ESC', cont: 300, maxS: 14, kg: 0.75, r: 0.0015, dims: [0.16, 0.045, 0.09] },
    esc_500: { name: '500 A / 16S ESC', cont: 500, maxS: 16, kg: 1.4, r: 0.001, dims: [0.19, 0.055, 0.11] },
  };
  const ESC_BURST = 1.25;
  const BATTERIES = {
    lipo5: { name: 'LiPo 5 Ah 70C', chem: 'LiPo', ah: 5, c: 70, vCell: 3.7, cutoff: 3.0, kgPerAhCell: 0.027, rCellAh: 0.012, whPerL: 300 },
    lipo8: { name: 'LiPo 8 Ah 60C', chem: 'LiPo', ah: 8, c: 60, vCell: 3.7, cutoff: 3.0, kgPerAhCell: 0.027, rCellAh: 0.012, whPerL: 300 },
    lipo12: { name: 'LiPo 12 Ah 45C', chem: 'LiPo', ah: 12, c: 45, vCell: 3.7, cutoff: 3.0, kgPerAhCell: 0.026, rCellAh: 0.013, whPerL: 300 },
    lipo16: { name: 'LiPo 16 Ah 35C', chem: 'LiPo', ah: 16, c: 35, vCell: 3.7, cutoff: 3.0, kgPerAhCell: 0.025, rCellAh: 0.014, whPerL: 310 },
    life10: { name: 'LiFePO4 10 Ah 25C', chem: 'LiFePO4', ah: 10, c: 25, vCell: 3.2, cutoff: 2.5, kgPerAhCell: 0.036, rCellAh: 0.02, whPerL: 190 },
    liion: { name: 'Li-ion 20 Ah 8C', chem: 'Li-ion', ah: 20, c: 8, vCell: 3.6, cutoff: 2.8, kgPerAhCell: 0.019, rCellAh: 0.035, whPerL: 420 },
  };
  const CELL_OPTIONS = [6, 8, 10, 12, 14, 16];
  const WHEELS = {
    w4: { name: '4 IN URETHANE', d: 0.102, w: 0.045, kg: 0.45, mu: 0.85 },
    w6: { name: '6 IN FOAM-FILLED', d: 0.152, w: 0.05, kg: 0.7, mu: 0.95 },
    w8: { name: '8 IN FOAM-FILLED', d: 0.203, w: 0.06, kg: 1.1, mu: 0.95 },
    w10: { name: '10 IN KNOBBY', d: 0.254, w: 0.07, kg: 1.9, mu: 1.0 },
    w14: { name: '14 IN SPOKED UHMW', d: 0.356, w: 0.05, kg: 2.6, mu: 0.75 },
    mec6: { name: '6 IN MECANUM', d: 0.152, w: 0.06, kg: 1.3, mu: 0.65, strafe: true },
    omni6: { name: '6 IN OMNI', d: 0.152, w: 0.05, kg: 0.9, mu: 0.7, strafe: true },
  };
  const TRANSMISSIONS = {
    belt: { name: 'TIMING BELT', eff: 0.95, kg: 0.3 },
    chain: { name: 'ROLLER CHAIN', eff: 0.93, kg: 0.6 },
    clutch: { name: 'BELT + CLUTCH', eff: 0.93, kg: 0.9 },
  };
  const GROUND = {
    none: { name: 'NONE', kg: 0 },
    forks: { name: 'GROUND FORKS', kg: 2.4 },
    skids: { name: 'WEDGELETS', kg: 3.6 },
  };
  const FINISHES = { factory: 'FACTORY FRESH', worn: 'PIT WORN', battle: 'BATTLE SCARRED' };
  const TYRES = { soft: { name: 'SOFT 35A', mu: 1.12, note: 'MOST GRIP, WEARS FAST' }, med: { name: 'MEDIUM 50A', mu: 1.0, note: 'ALL-ROUNDER' }, hard: { name: 'HARD 70A', mu: 0.9, note: 'LASTS, SLIDES MORE' } };
  // optional components: each is one checkbox, one line in the parts list and one small effect on the model
  const EXTRAS = {
    gyro: { name: 'GYRO STABILISER', spec: 'HEADING HOLD ON THE DRIVE MIX', kg: 0.03, usd: 60 },
    fans: { name: 'COOLING FANS x2', spec: '40 MM BLOWERS OVER THE CONTROLLERS', kg: 0.12, usd: 30 },
    shock: { name: 'SHOCK MOUNTS', spec: 'ELASTOMER ISOLATORS UNDER THE ELECTRONICS', kg: 0.25, usd: 45 },
    caps: { name: 'BUS CAPACITOR BANK', spec: 'LOW-ESR · CUTS VOLTAGE SAG', kg: 0.4, usd: 80 },
    telemetry: { name: 'TELEMETRY MODULE', spec: 'VOLTAGE · CURRENT · RPM DOWNLINK', kg: 0.04, usd: 70 },
    brake: { name: 'WEAPON BRAKE', spec: 'REGENERATIVE · FAST SPIN-DOWN', kg: 0.3, usd: 90 },
    rx2: { name: 'REDUNDANT RECEIVER', spec: 'SECOND 2.4 GHZ LINK', kg: 0.05, usd: 65 },
    batbox: { name: 'ARMOURED BATTERY BOX', spec: 'TITANIUM ENCLOSURE AROUND THE PACKS', kg: 1.6, usd: 220 },
    fpv: { name: 'FPV CAMERA', spec: 'ONBOARD VIDEO DOWNLINK', kg: 0.06, usd: 85 },
  };
  const FACES = ['front', 'side', 'rear', 'top'];
  // rough street prices, USD per kg of finished part unless a part has its own rule (see priceOf)
  const USD_PER_KG = { ar500: 9, hardox: 11, mild: 3, ti: 95, al7075: 14, cfrp: 120, uhmw: 12 };

  // legal: 'ok' = normal competition weapon, 'restricted' = allowed with limits, 'exhibition' = not competition legal
  const MODULES = {
    // kinetic
    vdisk: { name: 'VERTICAL DISK', cat: 'KINETIC', kind: 'spinner', desc: 'SINGLE-TOOTH UPWARD SPINNER', teeth: [1, 2], multi: true, legal: 'ok' },
    drum: { name: 'DRUM SPINNER', cat: 'KINETIC', kind: 'spinner', desc: 'WIDE LOW-INERTIA DRUM', teeth: [2, 3], multi: true, legal: 'ok' },
    egg: { name: 'EGGBEATER', cat: 'KINETIC', kind: 'spinner', desc: 'OPEN TWO-BAR BEATER', teeth: [2], multi: true, legal: 'ok' },
    hbar: { name: 'HORIZONTAL BAR', cat: 'KINETIC', kind: 'spinner', desc: 'MID-HEIGHT SWEEPING BAR', teeth: [2], multi: true, legal: 'ok' },
    under: { name: 'UNDERCUTTER', cat: 'KINETIC', kind: 'spinner', desc: 'FLOOR-LEVEL BLADE', teeth: [2], multi: true, legal: 'ok' },
    shell: { name: 'FULL-BODY SHELL', cat: 'KINETIC', kind: 'spinner', desc: 'SPINNING ARMOURED SHELL', teeth: [2, 3, 4], multi: true, legal: 'ok' },
    saw: { name: 'CUTTING SAW', cat: 'KINETIC', kind: 'spinner', desc: 'FIXED ABRASIVE DISK', teeth: [24], multi: false, legal: 'ok' },
    hammersaw: { name: 'HAMMER SAW', cat: 'KINETIC', kind: 'armsaw', desc: 'OVERHEAD ARM + SAW DISK', teeth: [24], multi: false, legal: 'ok' },
    hammer: { name: 'POWER HAMMER', cat: 'KINETIC', kind: 'hammer', desc: 'ELECTRIC SWINGING HAMMER', legal: 'ok' },
    axe: { name: 'OVERHEAD AXE', cat: 'KINETIC', kind: 'hammer', desc: 'BLADED SWING ARM', legal: 'ok' },
    ring: { name: 'RING SPINNER', cat: 'KINETIC', kind: 'spinner', desc: 'TOOTHED RING AROUND THE HULL', teeth: [2, 3, 4], multi: true, legal: 'ok' },
    angled: { name: 'ANGLED SPINNER', cat: 'KINETIC', kind: 'spinner', desc: 'TILTED DISK · HITS UP AND ACROSS', teeth: [1, 2], multi: false, legal: 'ok' },
    twin: { name: 'TWIN DISKS', cat: 'KINETIC', kind: 'spinner', desc: 'TWO VERTICAL DISKS ON ONE SHAFT', teeth: [1, 2], multi: true, legal: 'ok' },
    flail: { name: 'CHAIN FLAIL', cat: 'KINETIC', kind: 'spinner', desc: 'WEIGHTED CHAINS ON A HUB', teeth: [2, 3, 4], multi: false, legal: 'ok' },
    drill: { name: 'AUGER DRILL', cat: 'KINETIC', kind: 'spinner', desc: 'GEARED PIERCING AUGER', teeth: [1], multi: false, legal: 'ok' },
    punch: { name: 'PNEUMATIC PUNCH', cat: 'KINETIC', kind: 'punch', desc: 'STRAIGHT-LINE SPIKE RAM', legal: 'ok' },
    melty: { name: 'MELTY-BRAIN DRIVE', cat: 'KINETIC', kind: 'melty', desc: 'WHOLE BOT SPINS · STEERS BY PULSING THE WHEELS', legal: 'ok' },
    // control
    flipper: { name: 'PNEUMATIC FLIPPER', cat: 'CONTROL', kind: 'flipper', desc: 'GAS BUFFER + HINGED PLATE', legal: 'ok' },
    lifter: { name: 'ELECTRIC LIFTER', cat: 'CONTROL', kind: 'lifter', desc: 'GEARED LIFTING FORKS', legal: 'ok' },
    crusher: { name: 'HYDRAULIC CRUSHER', cat: 'CONTROL', kind: 'crusher', desc: 'PIERCING BEAK + JAW', legal: 'ok' },
    grabber: { name: 'CLAMP ARMS', cat: 'CONTROL', kind: 'grabber', desc: 'TWIN CLOSING CLAWS', legal: 'ok' },
    grablift: { name: 'GRAB-AND-LIFT', cat: 'CONTROL', kind: 'lifter', desc: 'LIFTING FORKS + CLAMP JAW', legal: 'ok' },
    suplex: { name: 'SUPLEX ARM', cat: 'CONTROL', kind: 'lifter', desc: 'GRABS AND THROWS OVER THE BACK', legal: 'ok' },
    // thermal
    flame: { name: 'FLAMETHROWER', cat: 'THERMAL', kind: 'flame', desc: 'PROPANE JET + PILOT', legal: 'restricted' },
    // electrical
    arc: { name: 'ARC EMITTER', cat: 'ELECTRICAL', kind: 'arc', desc: 'CAPACITOR-FED HV PRONGS', legal: 'exhibition' },
    // projectile
    spike: { name: 'SPIKE LAUNCHER', cat: 'PROJECTILE', kind: 'launcher', desc: 'PNEUMATIC TETHERED SPIKE', legal: 'restricted' },
    net: { name: 'NET LAUNCHER', cat: 'PROJECTILE', kind: 'launcher', desc: 'FOUR-BARREL ENTANGLER', legal: 'exhibition' },
    coil: { name: 'COILGUN', cat: 'PROJECTILE', kind: 'launcher', desc: 'STAGED EM ACCELERATOR', legal: 'exhibition' },
    cannon: { name: 'AUTOCANNON', cat: 'PROJECTILE', kind: 'launcher', desc: 'DRUM-FED BALLISTIC TURRET', legal: 'exhibition' },
    harpoon: { name: 'HARPOON WINCH', cat: 'PROJECTILE', kind: 'launcher', desc: 'BARBED HARPOON + REEL-IN WINCH', legal: 'restricted' },
    // passive
    forks: { name: 'FORK SET', cat: 'PASSIVE', kind: 'passive', desc: 'GROUND-SCRAPING TINES', legal: 'ok' },
    plow: { name: 'AR500 PLOW', cat: 'PASSIVE', kind: 'passive', desc: 'ANGLED DEFLECTOR', legal: 'ok' },
    ramp: { name: 'RAMP WEDGE', cat: 'PASSIVE', kind: 'passive', desc: 'FULL-WIDTH SCOOP', legal: 'ok' },
    spikes: { name: 'RAM SPIKES', cat: 'PASSIVE', kind: 'passive', desc: 'HARDENED IMPACT SPIKES', legal: 'ok' },
    tail: { name: 'THWACK TAIL', cat: 'PASSIVE', kind: 'passive', desc: 'WEIGHTED TAIL FOR SPIN ATTACKS', legal: 'ok' },
    srimech: { name: 'SELF-RIGHTING ARM', cat: 'PASSIVE', kind: 'srimech', desc: 'SERVO FLIP-OVER ARM', legal: 'ok' },
  };
  const MODULE_CATS = ['KINETIC', 'CONTROL', 'THERMAL', 'ELECTRICAL', 'PROJECTILE', 'PASSIVE'];
  // which kinds expose the motor / ESC / reduction controls
  const MOTORIZED = new Set(['spinner', 'armsaw', 'hammer', 'lifter', 'crusher']);
  const PRESSURIZED = new Set(['flipper', 'punch']);
  // gas supply for pneumatic rams: nitrogen holds pressure; liquid CO2 gives more shots per fill but chills and loses force
  const GAS = {
    n2: { name: 'NITROGEN', tank: 'N2 TANK + REGULATOR', spec: '4.5 L · 300 BAR', tankKg: 5.5, maxBar: 80, force: 1, usable: (p) => (300 - p) * 4.5 },
    co2: { name: 'LIQUID CO2', tank: 'CO2 TANK + REGULATOR', spec: '2 KG LIQUID · 57 BAR', tankKg: 3.6, maxBar: 55, force: 0.85, usable: () => 1100 },
  };

  const WIRE_GAUGES = [
    { awg: 8, burstA: 200, kgPerM: 0.1, d: 0.0055 },
    { awg: 6, burstA: 320, kgPerM: 0.15, d: 0.007 },
    { awg: 4, burstA: 500, kgPerM: 0.23, d: 0.0088 },
    { awg: 2, burstA: 800, kgPerM: 0.36, d: 0.011 },
    { awg: 0, burstA: 1400, kgPerM: 0.55, d: 0.0135 },
  ];
  const FUSE_SIZES = [100, 150, 200, 250, 300, 400, 500, 600, 800, 1000, 1500];

  // ride: with a full-body shell fitted, 'fixed' keeps a top module still on a centre mast, 'spin' bolts it to the shell roof
  const DEFAULT_MOD = { type: 'vdisk', scale: 1.0, motor: 'wm_l', count: 1, ratio: 1.15, esc: 'esc_300', teeth: 1, pressure: 60, trans: 'belt', ride: 'fixed', gas: 'n2' };
  const mod = (type, over) => ({ ...DEFAULT_MOD, type, ...(over || {}) });
  const DEFAULT_CFG = {
    name: 'UNIT 01', chassis: 'box',
    driveMotor: 'dm_m', driveRatio: 12, wheel: 'w6', driveEsc: 'esc_160',
    battery: 'lipo8', cells: 12, parallel: 2, bus: 'shared',
    armorMat: 'ti', armorT: 5, ground: 'none', livery: 'signal', finish: 'worn',
    cls: 'heavy', cluster: false, dimL: 1, dimW: 1, dimH: 1, wheelCount: 0, tyre: 'med', magnets: 0, guards: false, twoSpeed: false, susp: false, hub: false,
    extras: {}, armorFaces: null, ballastKg: 0, ballastZ: 0, paint: null, text: '',
    slots: { front: null, top: null, rear: null, left: null, right: null },
  };
  const cfgWith = (name, over, slots) => ({ ...DEFAULT_CFG, name, ...over, slots: { front: null, top: null, rear: null, left: null, right: null, ...slots } });
  const PRESETS = {
    vertical: cfgWith('VS-01 VERTICAL', { armorT: 4, parallel: 3, bus: 'isolated', battery: 'lipo5' }, { front: mod('vdisk', { scale: 0.96 }) }),
    drum: cfgWith('DR-02 DRUM', { chassis: 'compact', wheel: 'w8', driveRatio: 16, livery: 'hazard' }, { front: mod('drum', { scale: 0.95, teeth: 2, motor: 'wm_m', count: 2, ratio: 1.0 }) }),
    bar: cfgWith('HB-03 BAR', { chassis: 'tube', wheel: 'w8', driveRatio: 16, armorT: 6, ground: 'none', livery: 'mono', parallel: 3, bus: 'isolated' }, { front: mod('hbar', { teeth: 2, ratio: 2.0 }) }),
    shell: cfgWith('FS-04 SHELL', { chassis: 'round', wheel: 'w4', driveRatio: 8, armorMat: 'al7075', armorT: 3, ground: 'none', livery: 'cobalt', parallel: 3, bus: 'isolated' }, { top: mod('shell', { teeth: 2, count: 2, ratio: 3.4, scale: 0.7 }) }),
    flipper: cfgWith('FL-05 FLIPPER', { chassis: 'wedge', driveMotor: 'dm_l', driveRatio: 10, armorT: 6, livery: 'viper', parallel: 1 }, { front: mod('flipper'), rear: mod('srimech', { scale: 0.8 }) }),
    hammer: cfgWith('HS-06 SAW', { livery: 'olive', armorT: 5, ground: 'skids' }, { top: mod('hammersaw', { teeth: 24, motor: 'wm_m', esc: 'esc_160', ratio: 1.0 }), rear: mod('plow') }),
    crusher: cfgWith('CR-07 CRUSHER', { chassis: 'wedge', driveMotor: 'dm_l', livery: 'graphite', ground: 'none' }, { front: mod('crusher', { motor: 'wm_m', esc: 'esc_160' }) }),
    pyro: cfgWith('PY-08 PYRO', { chassis: 'sixwd', livery: 'rust', armorMat: 'ti', armorT: 2.5, ground: 'none' }, { top: mod('flame'), front: mod('drum', { teeth: 2, motor: 'wm_m', ratio: 1.0, scale: 0.85 }), rear: mod('spikes') }),
    k9: cfgWith('K9-09 HOUND', { chassis: 'dog', driveMotor: 'dm_m', driveRatio: 10, livery: 'gunship', ground: 'none', armorT: 3, armorMat: 'ti' }, { front: mod('saw', { teeth: 24, motor: 'wm_s', esc: 'esc_160', ratio: 1.5, scale: 0.8 }), top: mod('cannon') }),
    whip: cfgWith('BW-10 REAPER', { chassis: 'bigwheel', wheel: 'w14', driveRatio: 20, driveMotor: 'dm_l', livery: 'carbon', armorT: 5, ground: 'none' }, { rear: mod('under', { ratio: 1.6 }), top: mod('axe', { motor: 'wm_m', esc: 'esc_160' }) }),
    franken: cfgWith('FX-11 FRANKEN', { chassis: 'hex', livery: 'toxic', parallel: 2, armorMat: 'cfrp', armorT: 3, ground: 'none', wheel: 'w6' },
      { front: mod('drum', { scale: 0.7, teeth: 2, motor: 'wm_m', esc: 'esc_160', ratio: 1.0 }), top: mod('arc', { scale: 0.7 }), rear: mod('spikes'), left: mod('saw', { motor: 'wm_s', esc: 'esc_160', ratio: 1.5, scale: 0.7 }), right: mod('grabber', { scale: 0.7 }) }),
    ring: cfgWith('RG-12 HALO', { chassis: 'round', wheel: 'w4', driveRatio: 8, armorMat: 'al7075', armorT: 3, livery: 'royal', parallel: 3, bus: 'isolated' }, { top: mod('ring', { teeth: 2, count: 2, ratio: 4.5, scale: 0.7 }) }),
    melty: cfgWith('MB-13 DERVISH', { chassis: 'puck', cls: 'beetle', wheel: 'w6', driveMotor: 'dm_l', driveRatio: 6, armorMat: 'ti', armorT: 6, livery: 'toxic', parallel: 2, extras: { shock: true } }, { top: mod('melty'), left: mod('tail', { scale: 0.8 }), right: mod('tail', { scale: 0.8 }) }),
    tank: cfgWith('TK-14 GRAPPLE', { chassis: 'tracked', driveMotor: 'dm_l', driveRatio: 14, livery: 'desert', armorT: 4, parallel: 2 }, { front: mod('grablift', { motor: 'wm_s', esc: 'esc_160' }), rear: mod('srimech', { scale: 0.8 }) }),
    hexa: cfgWith('HX-15 ARACHNE', { chassis: 'hexapod', driveMotor: 'dm_m', driveRatio: 10, livery: 'carbon', armorT: 3, armorMat: 'ti', extras: { fpv: true } }, { top: mod('harpoon'), front: mod('drill', { motor: 'wm_s', esc: 'esc_160', ratio: 1.0 }) }),
    ubay: cfgWith('UF-16 CRADLE', { chassis: 'ushape', livery: 'cobalt', armorT: 4, parallel: 3, bus: 'isolated', battery: 'lipo5', guards: true }, { front: mod('twin', { teeth: 1, scale: 0.9 }) }),
    cat: cfgWith('HF-17 TWINHULL', { chassis: 'hframe', livery: 'arctic', armorT: 3, parallel: 3, bus: 'isolated', battery: 'lipo5', tyre: 'soft' }, { front: mod('angled', { scale: 0.85 }), rear: mod('tail') }),
    dart: cfgWith('DL-18 STILETTO', { chassis: 'delta', wheel: 'w8', driveMotor: 'dm_l', driveRatio: 14, livery: 'viper', armorFaces: { front: { mat: 'ar500', t: 8 }, side: { mat: 'ti', t: 4 }, rear: { mat: 'ti', t: 3 }, top: { mat: 'ti', t: 2.5 } }, parallel: 1, magnets: 1 },
      { front: mod('punch', { gas: 'co2', pressure: 55 }), rear: mod('srimech', { scale: 0.7 }) }),
    slab: cfgWith('PK-19 FLATLINE', { chassis: 'pancake', wheel: 'w4', driveRatio: 9, livery: 'graphite', armorT: 4, hub: true, cells: 8, parallel: 2, driveEsc: 'esc_160' }, { top: mod('flail', { ratio: 2.0, teeth: 3, esc: 'esc_160', motor: 'wm_m' }), front: mod('forks') }),
    trike: cfgWith('TR-20 SUPLEX', { chassis: 'tri', cls: 'feather', wheel: 'w8', driveMotor: 'dm_l', driveRatio: 14, livery: 'hazard', armorT: 4, twoSpeed: true, text: 'SUPLEX' }, { front: mod('suplex', { motor: 'wm_m', esc: 'esc_160' }) }),
    pair: cfgWith('CL-21 TWINS', { chassis: 'compact', cls: 'light', cluster: true, wheel: 'w6', driveRatio: 12, livery: 'olive', armorT: 3, parallel: 1 }, { front: mod('drum', { teeth: 2, motor: 'wm_m', ratio: 1.0, scale: 0.8 }) }),
  };

  // ---------------------------------------------------------------------------
  // NORMALISATION — repairs bad values; never rejects a combination
  // ---------------------------------------------------------------------------
  function normalizeMod(m) {
    if (!m || !m.type || m.type === 'none' || !MODULES[m.type]) return null;
    const out = { ...DEFAULT_MOD, ...m };
    const def = MODULES[out.type];
    if (!WEAPON_MOTORS[out.motor]) out.motor = DEFAULT_MOD.motor;
    if (!ESCS[out.esc]) out.esc = DEFAULT_MOD.esc;
    if (!TRANSMISSIONS[out.trans]) out.trans = 'belt';
    if (out.ride !== 'spin') out.ride = 'fixed';
    out.gas = out.gas === 'co2' ? 'co2' : 'n2';
    if (def.teeth && !def.teeth.includes(out.teeth)) out.teeth = def.teeth[0];
    out.count = def.multi ? clamp(Math.round(out.count) || 1, 1, 2) : 1;
    out.scale = clamp(Number(out.scale) || 1, 0.7, 1.3);
    out.ratio = clamp(Number(out.ratio) || 1, 0.6, 6);
    out.pressure = clamp(Number(out.pressure) || 60, 20, 80);
    return out;
  }

  function normalize(input) {
    const cfg = { ...DEFAULT_CFG, ...input };
    if (!CHASSIS[cfg.chassis]) cfg.chassis = DEFAULT_CFG.chassis;
    if (!DRIVE_MOTORS[cfg.driveMotor]) cfg.driveMotor = DEFAULT_CFG.driveMotor;
    if (!ESCS[cfg.driveEsc]) cfg.driveEsc = DEFAULT_CFG.driveEsc;
    if (!BATTERIES[cfg.battery]) cfg.battery = DEFAULT_CFG.battery;
    if (!WHEELS[cfg.wheel]) cfg.wheel = DEFAULT_CFG.wheel;
    if (!MATERIALS[cfg.armorMat]) cfg.armorMat = DEFAULT_CFG.armorMat;
    // a chassis carries nothing by default: forks, wedges and spikes exist only as hardpoint modules
    cfg.ground = 'none';
    if (!FINISHES[cfg.finish]) cfg.finish = 'worn';
    if (!CELL_OPTIONS.includes(cfg.cells)) cfg.cells = 12;
    cfg.parallel = clamp(Math.round(cfg.parallel) || 1, 1, 4);
    cfg.driveRatio = clamp(Number(cfg.driveRatio) || 12, 4, 40);
    cfg.armorT = clamp(Number(cfg.armorT) || 5, 2, 12);
    if (cfg.bus !== 'isolated') cfg.bus = 'shared';
    if (!CLASSES[cfg.cls]) cfg.cls = 'heavy';
    cfg.cluster = !!cfg.cluster;
    for (const d of ['dimL', 'dimW', 'dimH']) cfg[d] = clamp(Number(cfg[d]) || 1, 0.8, 1.25);
    cfg.wheelCount = [2, 4, 6, 8].includes(Number(cfg.wheelCount)) ? Number(cfg.wheelCount) : 0;
    if (!TYRES[cfg.tyre]) cfg.tyre = 'med';
    cfg.magnets = clamp(Math.round(Number(cfg.magnets) || 0), 0, 3);
    for (const b of ['guards', 'twoSpeed', 'susp', 'hub']) cfg[b] = !!cfg[b];
    const ex = {};
    for (const k of Object.keys(EXTRAS)) ex[k] = !!(cfg.extras && cfg.extras[k]);
    cfg.extras = ex;
    if (cfg.armorFaces && typeof cfg.armorFaces === 'object') {
      const af = {};
      for (const fc of FACES) { const q = cfg.armorFaces[fc] || {}; af[fc] = { mat: MATERIALS[q.mat] ? q.mat : cfg.armorMat, t: clamp(Number(q.t) || (fc === 'top' ? 3 : 5), fc === 'top' ? 1.5 : 2, 12) }; }
      cfg.armorFaces = af;
    } else cfg.armorFaces = null;
    cfg.ballastKg = clamp(Number(cfg.ballastKg) || 0, 0, 20);
    cfg.ballastZ = clamp(Number(cfg.ballastZ) || 0, -1, 1);
    const hex = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null);
    cfg.paint = cfg.paint && hex(cfg.paint.armor) && hex(cfg.paint.top) && hex(cfg.paint.accent) ? { armor: hex(cfg.paint.armor), top: hex(cfg.paint.top), accent: hex(cfg.paint.accent) } : null;
    if (cfg.livery === 'custom' && !cfg.paint) cfg.livery = 'signal';
    cfg.text = String(cfg.text || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 10).trim();
    const slots = {};
    for (const s of SLOTS) slots[s] = normalizeMod((input && input.slots && input.slots[s]) || (cfg.slots && cfg.slots[s]));
    cfg.slots = slots;
    return cfg;
  }

  // chassis with the build's length / width / height multipliers applied
  function chassisOf(cfg) {
    const b = CHASSIS[cfg.chassis];
    const ch = { ...b, L: b.L * cfg.dimL, W: b.W * (b.shape === 'round' ? cfg.dimL : cfg.dimW), H: b.H * cfg.dimH };
    if (b.R) ch.R = b.R * cfg.dimL;
    return ch;
  }
  // armour on one face: per-face override if set, otherwise the uniform material / thickness (top plate at 60%)
  const faceOf = (cfg, fc) => (cfg.armorFaces ? cfg.armorFaces[fc] : { mat: cfg.armorMat, t: fc === 'top' ? Math.max(3, cfg.armorT * 0.6) : cfg.armorT });

  const escCountOf = (m) => (m && MOTORIZED.has(MODULES[m.type].kind) ? m.count : 0);

  // ---------------------------------------------------------------------------
  // LAYOUT — bot frame: +Z forward, +X right, Y up, floor at y=0
  // ---------------------------------------------------------------------------
  function batteryPackDims(bat, S) {
    const wh = S * bat.vCell * bat.ah;
    const vol = wh / bat.whPerL / 1000;
    let h = 0.052, w = 0.092;
    let len = vol / (h * w);
    if (len > 0.26) { h = 0.07; w = 0.125; len = vol / (h * w); }
    return { len, w, h, wh, vol };
  }

  function layoutFor(cfg, nWeaponEsc, opt) {
    const ch = chassisOf(cfg);
    const wheel = WHEELS[cfg.wheel];
    const P = cfg.parallel;
    const isDog = ch.shape === 'dog';
    const wR = isDog ? 0.03 : wheel.d / 2;
    const H = ch.H;
    const bottomY = isDog ? 0.25 : Math.max(0.008, wR - H / 2);
    const cy = bottomY + H / 2;
    const topY = bottomY + H;
    const floorY = bottomY + (ch.baseT || 0.005);
    const bat = BATTERIES[cfg.battery];
    const pack = batteryPackDims(bat, cfg.cells);
    const dEsc = ESCS[cfg.driveEsc];
    const dm = DRIVE_MOTORS[cfg.driveMotor];
    const isolated = cfg.bus === 'isolated' && P >= 2;
    const tSide = faceOf(cfg, 'side').t / 1000;
    const tTop = faceOf(cfg, 'top').t / 1000;
    const tFace = { front: faceOf(cfg, 'front').t / 1000, rear: faceOf(cfg, 'rear').t / 1000, side: tSide };
    const dmY = isDog ? cy : Math.max(wR, floorY + dm.d / 2 + 0.004);
    const lay = { shape: ch.shape, L: ch.L, W: ch.W, H, bottomY, cy, topY, floorY, wR, wheelW: wheel.w, axleY: wR, pack, isolated, tSide, tTop, tFace, deckY: topY + tTop };

    const placeWeaponEscs = (escDims) => {
      const tops = lay.packs.filter((pk, j) => !lay.packs.some((o, q) => q !== j && o.x === pk.x && o.z === pk.z && o.y > pk.y));
      const level = {};
      lay.weaponEscs = [];
      let stackTop = Math.max(...lay.packs.map((pk) => pk.y + pack.h / 2));
      for (let i = 0; i < nWeaponEsc; i++) {
        const j = i % tops.length;
        const dims = escDims[i];
        const base = level[j] || tops[j].y + pack.h / 2 + 0.004;
        const y = base + dims[1] / 2;
        level[j] = base + dims[1] + 0.004;
        lay.weaponEscs.push({ x: tops[j].x, y, z: tops[j].z, rotY: tops[j].rotY });
        stackTop = Math.max(stackTop, y + dims[1] / 2);
      }
      lay.stackTop = stackTop;
    };
    lay.placeWeaponEscs = placeWeaponEscs;

    if (ch.shape === 'round') {
      const Rb = ch.R, q = Rb / 0.34;
      lay.Rb = Rb;
      lay.nW = 2;
      lay.wheels = [{ x: -0.235 * q, y: wR, z: 0 }, { x: 0.235 * q, y: wR, z: 0 }];
      lay.driveMotors = [{ x: -0.14 * q, y: dmY, z: 0, side: -1 }, { x: 0.14 * q, y: dmY, z: 0, side: 1 }];
      lay.driveEscs = [{ x: -0.215 * q, y: floorY + dEsc.dims[1] / 2, z: 0.13 * q, rotY: 0 }, { x: 0.215 * q, y: floorY + dEsc.dims[1] / 2, z: 0.13 * q, rotY: 0 }];
      lay.packs = [];
      for (let i = 0; i < P; i++) {
        const layer = Math.floor(i / 2), col = i % 2;
        lay.packs.push({ x: 0, y: floorY + pack.h / 2 + layer * (pack.h + 0.004), z: -0.11 * q - col * (pack.w + 0.01), rotY: Math.PI / 2 });
      }
      lay.switches = [{ x: 0.2 * q, y: topY - 0.035, z: -0.16 * q }];
      if (isolated) lay.switches.push({ x: -0.2 * q, y: topY - 0.035, z: -0.16 * q });
      lay.fuse = { x: 0.2 * q, y: floorY + 0.02, z: -0.08 * q };
      lay.buses = [{ x: -0.2 * q, y: floorY + 0.012, z: -0.11 * q, rotY: Math.PI / 2 }];
      if (isolated) lay.buses.push({ x: 0.14 * q, y: floorY + 0.012, z: -0.24 * q, rotY: 0 });
      lay.receiver = { x: 0, y: floorY + 0.03, z: -0.3 * q };
      lay.bayVolume = Math.PI * Rb * Rb * (H - 0.02);
      lay.bayHalfW = 0.2 * q;
      lay.footprint = { zFront: Rb, zRear: -Rb, xHalf: Rb };
      lay.wheelbase = { zFront: 0, zRear: 0 };
      lay.skidZ = 0.26 * q;
      lay.coverR = Rb + 0.06;
      lay.notch = { f: 0, r: 0, half: 0 }; lay.taper = 1;
      lay.extraPos = (i) => ({ x: Math.cos(0.6 + i * 0.5) * Rb * 0.42, y: floorY + 0.02, z: Math.sin(0.6 + i * 0.5) * Rb * 0.42 + Rb * 0.25 });
      const em = (x, z, rot, halfW) => ({ kind: 'edge', x, z, rot, halfW, deckY: lay.deckY, cy, bottomY, topY, inset: 0, round: true });
      lay.mounts = {
        front: em(0, Rb, 0, 0.2 * q), rear: em(0, -Rb, Math.PI, 0.2 * q), left: em(-Rb, 0, -Math.PI / 2, 0.2 * q), right: em(Rb, 0, Math.PI / 2, 0.2 * q),
        top: { kind: 'deck', x: 0, z: 0, rot: 0, halfW: Rb, halfL: Rb, deckY: lay.deckY, cy, bottomY, topY, inset: 0 },
      };
      return lay;
    }

    const L = ch.L, W = ch.W;
    const outboard = ch.shape === 'bigwheel' || ch.shape === 'delta';
    const nW = isDog ? 0 : ch.tracks ? 4 : cfg.wheelCount && !ch.caster ? cfg.wheelCount : ch.wheels;
    lay.nW = nW;
    const wheelX = isDog ? W / 2 + 0.06 : W / 2 - wheel.w / 2 - (outboard ? 0 : 0.014);
    const xi = isDog ? W / 2 - 0.02 : W / 2 - wheel.w - (outboard ? 0.05 : 0.034);
    lay.xi = xi;
    lay.wheels = [];
    lay.legs = [];
    if (isDog) {
      const zl = L / 2 - 0.1, rows = ch.legs / 2;
      for (let r = 0; r < rows; r++) { const z = rows === 1 ? 0 : zl - (2 * zl * r) / (rows - 1); for (const sx of [-1, 1]) lay.legs.push({ x: sx * wheelX, y: cy, z, side: sx, front: z > 0.01, row: r }); }
      lay.driveMotors = lay.legs.map((lg) => ({ x: lg.side * (xi - 0.06), y: cy, z: lg.z, side: lg.side }));
      lay.wheelbase = { zFront: zl, zRear: -zl };
    } else if (nW >= 4) {
      const cut = ch.shape === 'hex' ? 0.17 * L : 0;
      lay.cut = cut;
      const zw = cut ? Math.max(wR + 0.012, L / 2 - cut - wR - 0.03) : L / 2 - wR - 0.035;
      const per = nW / 2, zs = Array.from({ length: per }, (_, i) => zw - (2 * zw * i) / (per - 1));
      for (const z of zs) { lay.wheels.push({ x: -wheelX, y: wR, z }); lay.wheels.push({ x: wheelX, y: wR, z }); }
      const mz = per % 2 === 1 ? zw * 0.5 : 0;
      lay.driveMotors = [{ x: -(xi - 0.075), y: dmY, z: mz, side: -1 }, { x: xi - 0.075, y: dmY, z: mz, side: 1 }];
      lay.wheelbase = { zFront: zw, zRear: -zw };
    } else {
      const zLim = outboard ? L / 2 - 0.05 : L / 2 - wR - 0.04;
      let za = opt && opt.axleZ !== undefined ? clamp(opt.axleZ, -zLim, zLim) : L * 0.05;
      if (ch.shape === 'delta') za = Math.min(za, -L * 0.2); // the wheels sit at the wide end
      if (ch.caster) za = Math.min(za, 0);
      lay.wheels = [{ x: -wheelX, y: wR, z: za }, { x: wheelX, y: wR, z: za }];
      lay.driveMotors = [{ x: -(xi - 0.075), y: dmY, z: za, side: -1 }, { x: xi - 0.075, y: dmY, z: za, side: 1 }];
      lay.wheelbase = { zFront: za, zRear: za };
    }
    if (cfg.hub && lay.wheels.length) lay.driveMotors = lay.wheels.map((w) => { const sd = w.x < 0 ? -1 : 1; return { x: w.x - sd * (wheel.w / 2 + dm.l / 2 + 0.012), y: w.y, z: w.z, side: sd }; });
    if (ch.caster) lay.caster = { x: 0, y: 0.03, z: L / 2 - 0.07 };
    // U and H frames have bays cut into the ends; the electronics bay starts behind the rear bay
    const notch = ch.shape === 'ushape' ? { f: 0.3 * L, r: 0 } : ch.shape === 'hframe' ? { f: 0.24 * L, r: 0.24 * L } : { f: 0, r: 0 };
    const rearZ = -L / 2 + notch.r;
    lay.skidZ = L / 2 + 0.02;
    const escX = Math.max(0.05, xi - 0.045);
    lay.driveEscs = [
      { x: -escX, y: floorY + dEsc.dims[1] / 2, z: rearZ + 0.12, rotY: 0 },
      { x: escX, y: floorY + dEsc.dims[1] / 2, z: rearZ + 0.12, rotY: 0 },
    ];
    lay.packs = [];
    const packZ = rearZ + 0.085 + pack.len / 2;
    for (let i = 0; i < P; i++) lay.packs.push({ x: (i - (P - 1) / 2) * (pack.w + 0.012), y: floorY + pack.h / 2, z: packZ, rotY: 0 });
    lay.switches = [{ x: Math.min(0.1, xi - 0.06), y: topY - 0.035, z: rearZ + 0.05 }];
    if (isolated) lay.switches.push({ x: -Math.min(0.1, xi - 0.06), y: topY - 0.035, z: rearZ + 0.05 });
    lay.fuse = { x: 0, y: floorY + 0.02, z: rearZ + 0.05 };
    const busZ = Math.min(L / 2 - 0.06, packZ + pack.len / 2 + 0.035);
    lay.buses = isolated
      ? [{ x: 0.085, y: floorY + 0.012, z: busZ, rotY: 0 }, { x: -0.085, y: floorY + 0.012, z: busZ, rotY: 0 }]
      : [{ x: Math.min(0.06, xi - 0.09), y: floorY + 0.012, z: busZ, rotY: 0 }];
    lay.receiver = { x: -Math.min(0.11, xi - 0.05), y: floorY + 0.03, z: rearZ + 0.05 };
    lay.bayVolume = 2 * xi * (L - 0.06) * (H - 0.02);
    lay.bayHalfW = xi - 0.01;
    lay.footprint = { zFront: L / 2, zRear: -L / 2, xHalf: W / 2 };
    lay.coverR = Math.hypot(L / 2, W / 2) + 0.05;
    const nose = ch.shape === 'wedge' ? 0.16 : 0;
    lay.nose = nose;
    const bodyHalfW = outboard ? xi + 0.02 : W / 2;
    lay.bodyHalfW = bodyHalfW;
    lay.notch = { f: notch.f, r: notch.r, half: bodyHalfW * 0.44 };
    lay.taper = ch.shape === 'delta' ? 0.3 : 1; // front width as a fraction of the rear width
    lay.extraPos = (i) => ({ x: -Math.min(0.14, xi - 0.06) + (i % 4) * 0.05, y: floorY + 0.02, z: Math.min(L / 2 - 0.1, busZ + 0.09 + Math.floor(i / 4) * 0.06) });
    const em = (x, z, rot, halfW, inset) => ({ kind: 'edge', x, z, rot, halfW, deckY: lay.deckY, cy, bottomY, topY, inset: inset || 0 });
    lay.mounts = {
      front: em(0, L / 2 - notch.f + tFace.front + nose, 0, notch.f ? lay.notch.half - 0.01 : (bodyHalfW - (lay.cut || 0)) * lay.taper, nose),
      rear: em(0, -(L / 2 - notch.r + tFace.rear), Math.PI, notch.r ? lay.notch.half - 0.01 : bodyHalfW - (lay.cut || 0), 0),
      left: em(-(bodyHalfW * (1 + lay.taper) / 2 + tSide), 0, -Math.PI / 2, (L / 2 - (lay.cut || 0)) * (lay.taper < 1 ? 0.6 : 1), 0),
      right: em(bodyHalfW * (1 + lay.taper) / 2 + tSide, 0, Math.PI / 2, (L / 2 - (lay.cut || 0)) * (lay.taper < 1 ? 0.6 : 1), 0),
      top: { kind: 'deck', x: 0, z: 0, rot: 0, halfW: bodyHalfW, halfL: L / 2, deckY: lay.deckY, cy, bottomY, topY, inset: 0 },
    };
    return lay;
  }

  // A full-body shell encloses the whole chassis, so nothing else can stay bolted to the chassis and poke through it.
  // With a shell fitted the other hardpoints move: side mounts go onto the shell wall and spin with it; the top
  // mount either rides the shell roof (spins) or sits on a stationary hollow mast through the shell's hub.
  function shellDims(lay, md) {
    const wm = WEAPON_MOTORS[md.motor];
    const R = lay.coverR * (1 + (md.scale - 1) * 0.25), yBot = 0.028;
    return { R, yBot, h: lay.deckY + wm.l + 0.075 - yBot };
  }
  function applyShellMounts(lay, cfg, shellSlot) {
    const sd = shellDims(lay, cfg.slots[shellSlot]);
    const roofY = sd.yBot + sd.h + 0.006;
    const sh = { slot: shellSlot, R: sd.R, yBot: sd.yBot, h: sd.h, roofY, mastDeck: null, riders: [] };
    const rot = { front: 0, rear: Math.PI, left: -Math.PI / 2, right: Math.PI / 2 };
    for (const s of SLOTS) {
      if (s === shellSlot || !cfg.slots[s]) continue;
      const base = { cy: sd.yBot + sd.h * 0.21, bottomY: sd.yBot, topY: roofY, inset: 0 };
      if (s === 'top') {
        if (cfg.slots[s].ride === 'spin') { lay.mounts[s] = { kind: 'deck', x: 0, z: 0, rot: 0, halfW: sd.R * 0.8, halfL: sd.R * 0.8, deckY: roofY + 0.024, ...base, onShell: true }; sh.riders.push(s); }
        else { sh.mastDeck = roofY + 0.075; lay.mounts[s] = { kind: 'deck', x: 0, z: 0, rot: 0, halfW: 0.17, halfL: 0.17, deckY: sh.mastDeck, ...base, onMast: true }; }
      } else {
        const r = sd.R + 0.008;
        lay.mounts[s] = { kind: 'edge', x: Math.sin(rot[s]) * r, z: Math.cos(rot[s]) * r, rot: rot[s], halfW: Math.min(0.2, sd.R * 0.5), deckY: roofY, ...base, onShell: true };
        sh.riders.push(s);
      }
    }
    lay.shell = sh;
  }

  // module-local point (x lateral, y absolute height, z outward from the mount face) -> bot frame
  function toBot(m, p) {
    const c = Math.cos(m.rot), s = Math.sin(m.rot);
    return { x: m.x + p.x * c + p.z * s, y: p.y, z: m.z - p.x * s + p.z * c };
  }

  // ---------------------------------------------------------------------------
  // SPINNER SPIN-UP
  // ---------------------------------------------------------------------------
  function simulateSpinner(p) {
    const kt = 60 / (2 * Math.PI * p.motor.kv);
    const iLim = Math.min(p.motor.iMax, p.esc.cont * ESC_BURST, p.iPackMax / p.n);
    const rEach = p.motor.r + p.esc.r + p.rPack * p.n;
    const dt = 0.01, friction = 0.3;
    let w = 0, t = 0, iEach = 0, peakI = 0;
    const samples = [];
    for (let step = 0; step < 4000; step++) {
      iEach = clamp((p.V - kt * w * p.ratio) / rEach, 0, iLim);
      const tau = p.n * kt * iEach * p.ratio * p.eff - p.dragK * w * w - (w > 0 ? friction : 0);
      if (step % 10 === 0) samples.push({ t, w, i: iEach * p.n });
      peakI = Math.max(peakI, iEach * p.n);
      w = Math.max(0, w + (tau / p.inertia) * dt);
      t += dt;
    }
    const wFinal = w;
    let t90 = null, e90 = 0;
    for (const s of samples) if (t90 === null && s.w >= 0.9 * wFinal) t90 = s.t;
    for (const s of samples) if (t90 !== null && s.t <= t90) e90 += p.V * s.i * 0.1;
    const tEnd = Math.min(40, (t90 || 40) * 1.6 + 1);
    return {
      kt, iLim, iPeak: peakI, iHold: iEach * p.n, wFinal, t90, tEnd, curve: samples.filter((s) => s.t <= tEnd),
      rpm: (wFinal * 60) / (2 * Math.PI), tip: wFinal * p.tipR, ke: 0.5 * p.inertia * wFinal * wFinal,
      spinEnergyJ: e90, torqueStart: p.n * kt * iLim * p.ratio * p.eff,
    };
  }

  // ---------------------------------------------------------------------------
  // MODULES — each returns its geometry, parts, electrical demand and display rows
  // ---------------------------------------------------------------------------
  function moduleCalc(slot, md, lay, env) {
    const def = MODULES[md.type];
    const m = lay.mounts[slot];
    const edge = m.kind === 'edge';
    const s = md.scale;
    const baseY = edge ? 0.012 : m.deckY; // surface the tool must clear
    const A = { y: m.deckY, z: edge ? -(m.inset + 0.17) : 0 }; // anchor for deck-mounted tools
    const wm = WEAPON_MOTORS[md.motor], esc = ESCS[md.esc], tr = TRANSMISSIONS[md.trans];
    const o = {
      slot, type: md.type, def, md, kind: def.kind, mount: m, parts: [], escs: 0, motorPos: [], iPeak: 0, iHold: 0, wh: 0,
      rows: [], checks: [], hero: { v: '—', u: '', l: def.name }, action: { kind: 'none', verb: '—' }, topMost: 0, angMom: 0, loads: {},
      geo: { s, edge, baseY, A: { ...A } },
    };
    const g = o.geo;
    const part = (id, name, spec, kg, p, qty, inBot) => o.parts.push({ id: `${slot}:${id}`, cat: 'WEAPON', name, spec, kg, qty: qty || 1, total: kg * (qty || 1), pos: inBot ? p : toBot(m, p), slot });
    const chk = (id, label, status, detail) => o.checks.push({ id: `${slot}:${id}`, label: `${SLOT_NAMES[slot]} · ${label}`, status, detail });
    const motors = (list, label) => {
      o.motorPos = list;
      list.forEach((p, i) => part('motor' + i, label, `${wm.name} · ${wm.kv} KV`, wm.kg, p));
      o.escs = list.length;
      chk('escv', 'ESC VOLTAGE', esc.maxS >= env.S ? 'pass' : 'fail', `${env.S}S PACK ON ${esc.maxS}S ESC`);
    };
    const iLimEach = (n) => Math.min(wm.iMax, esc.cont * ESC_BURST, env.iPackMax / n);
    const legal = () => {
      if (def.legal === 'exhibition') chk('rules', def.name, 'warn', 'EXHIBITION ONLY · NOT COMPETITION LEGAL');
      else if (def.legal === 'restricted') chk('rules', def.name, 'info', 'ALLOWED WITH EVENT-SPECIFIC LIMITS');
    };

    // ---- spinners -----------------------------------------------------------
    if (def.kind === 'spinner' || def.kind === 'armsaw') {
      const k = md.type;
      let R, mass, inertia, tipR, dragK, hubKg = 3, axis = 'x', rotorPos, dims = {};
      if (k === 'vdisk') { R = 0.21 * s; dims.t = 0.07; mass = Math.PI * R * R * dims.t * RHO_STEEL * 0.42; inertia = 0.5 * mass * R * R * 0.95; tipR = R; dragK = 0.5 * 0.03 * RHO_AIR * Math.pow(R, 5); hubKg = 4.5; }
      else if (k === 'saw' || k === 'hammersaw') { R = (k === 'saw' ? 0.17 : 0.15) * s; dims.t = 0.01; mass = Math.PI * R * R * dims.t * RHO_STEEL * 0.9; inertia = 0.5 * mass * R * R; tipR = R; dragK = 0.5 * 0.03 * RHO_AIR * Math.pow(R, 5); hubKg = 1.2; }
      else if (k === 'drum') { R = 0.085 * s; dims.Ri = R - 0.03; dims.Lw = Math.min(0.3, 2 * m.halfW - 0.16); const body = Math.PI * (R * R - dims.Ri * dims.Ri) * dims.Lw * RHO_STEEL; tipR = R + 0.014; mass = body + md.teeth; inertia = 0.5 * body * (R * R + dims.Ri * dims.Ri) + md.teeth * tipR * tipR; dragK = RHO_AIR * 0.02 * Math.PI * Math.pow(R, 4) * dims.Lw; }
      else if (k === 'egg') { R = 0.115 * s; dims.Lw = Math.min(0.26, 2 * m.halfW - 0.16); const bars = 2 * 0.03 * 0.05 * dims.Lw * RHO_STEEL; const ends = 2 * Math.PI * R * R * 0.012 * RHO_STEEL * 0.45; mass = bars + ends; tipR = R; inertia = bars * (R - 0.015) * (R - 0.015) + 0.5 * ends * R * R; dragK = (RHO_AIR * 1.1 * dims.Lw * Math.pow(R, 3)) / 2; hubKg = 2.4; }
      else if (k === 'hbar' || k === 'under') { axis = 'y'; dims.Lb = (k === 'hbar' ? 0.8 : 0.7) * s; dims.w = 0.1; dims.t = k === 'hbar' ? 0.038 : 0.025; R = dims.Lb / 2; mass = dims.Lb * dims.w * dims.t * RHO_STEEL; inertia = (mass * (dims.Lb * dims.Lb + dims.w * dims.w)) / 12; tipR = R; dragK = (RHO_AIR * 0.9 * dims.t * Math.pow(R, 4)) / 4; hubKg = 5; }
      else if (k === 'angled') { R = 0.2 * s; dims.t = 0.06; dims.tilt = 0.45; mass = Math.PI * R * R * dims.t * RHO_STEEL * 0.42; inertia = 0.5 * mass * R * R * 0.95; tipR = R; dragK = 0.5 * 0.03 * RHO_AIR * Math.pow(R, 5); hubKg = 4.5; }
      else if (k === 'twin') { R = 0.17 * s; dims.t = 0.032; dims.gap = clamp(2 * m.halfW - 0.2, 0.07, 0.16); dims.Lw = dims.gap + dims.t; mass = 2 * Math.PI * R * R * dims.t * RHO_STEEL * 0.45; inertia = 0.5 * mass * R * R * 0.95; tipR = R; dragK = 0.03 * RHO_AIR * Math.pow(R, 5); hubKg = 4; }
      else if (k === 'flail') { axis = 'y'; dims.Lb = 0.74 * s; dims.w = 0.06; dims.t = 0.05; R = dims.Lb / 2; const wKg = 1.6 * s; mass = md.teeth * (wKg + 0.5) + 2.5; inertia = md.teeth * (wKg * (R - 0.03) * (R - 0.03) + (0.5 * R * R) / 3) + 0.01; tipR = R; dragK = ((RHO_AIR * 0.9 * dims.t * Math.pow(R, 4)) / 4) * (md.teeth / 4); hubKg = 3; }
      else if (k === 'drill') { axis = 'z'; R = 0.07 * s; dims.Lb = 0.34 * s; dims.gear = 12; mass = ((Math.PI * R * R * dims.Lb * RHO_STEEL) / 3) * 0.5; inertia = 0.3 * mass * R * R; tipR = R; dragK = 1e-6; hubKg = 2.2; }
      else if (k === 'ring') { axis = 'y'; R = lay.coverR * (1 + (s - 1) * 0.1); dims.t = 0.05; dims.wall = 0.016; const band = 2 * Math.PI * R * dims.wall * dims.t * RHO_STEEL; const teeth = 1.0 * md.teeth; tipR = R + 0.03; mass = band + teeth; inertia = band * R * R + teeth * tipR * tipR; dragK = RHO_AIR * 0.01 * Math.PI * Math.pow(R, 4) * dims.t * 2; hubKg = 4; }
      else { axis = 'y'; R = lay.coverR * (1 + (s - 1) * 0.25); dims.t = 0.004 + 0.004 * s; dims.yBot = 0.028; dims.h = lay.deckY + wm.l + 0.075 - dims.yBot; const wall = 2 * Math.PI * R * dims.h * dims.t * RHO_STEEL; const top = Math.PI * R * R * 0.004 * RHO_STEEL * 0.5; const teeth = 1.2 * md.teeth; tipR = R + 0.022; mass = wall + top + teeth; inertia = wall * R * R + 0.5 * top * R * R + teeth * tipR * tipR; dragK = RHO_AIR * 0.01 * Math.PI * Math.pow(R, 4) * dims.h + 0.5 * 0.01 * RHO_AIR * Math.pow(R, 5); hubKg = 6; }
      if (k === 'shell' && env.ride) { inertia += env.ride.I; tipR = Math.max(tipR, env.ride.tip); }
      Object.assign(g, dims, { R, tipR, axis });

      const n = md.count;
      const sides = n === 1 ? [1] : [1, -1];
      let mpos = [];
      if (k === 'ring') {
        // a ring carried on guide rollers around the hull at mid height; the motor sits inside and drives it through a pinion
        g.center = true; g.ring = true;
        g.yA = Math.max(lay.cy, dims.t / 2 + 0.02);
        rotorPos = { x: 0, y: g.yA, z: 0 };
        const zm = lay.Rb ? lay.Rb * 0.45 : lay.L / 2 - lay.notch.f - 0.09;
        mpos = sides.map((sd) => ({ x: sd * lay.bayHalfW * 0.55, y: lay.floorY + wm.l / 2 + 0.004, z: zm, axis: 'y', side: sd, bot: true }));
        o.topMost = g.yA + 0.04;
      } else if (axis === 'z') {
        const rr = Math.max(R, wm.d / 2);
        g.yA = edge ? Math.max(m.cy, rr + 0.02) : baseY + rr + 0.02;
        g.zA = edge ? 0.07 : 0.06;
        rotorPos = { x: 0, y: g.yA, z: g.zA + dims.Lb / 2 };
        mpos = [{ x: R + wm.d / 2 + 0.035, y: g.yA, z: edge ? wm.l / 2 + 0.012 : -0.02, axis: 'z', side: 1 }];
        o.topMost = g.yA + rr + 0.02;
      } else if (k === 'shell') {
        // centred on the chassis whatever hardpoint it is assigned to; motors stand on the deck under the roof
        g.center = true;
        rotorPos = { x: 0, y: dims.yBot + dims.h / 2, z: 0 };
        mpos = sides.map((sd) => ({ x: n === 1 ? 0 : sd * 0.1, y: lay.deckY + wm.l / 2 + 0.004, z: 0.17, axis: 'y', side: sd, bot: true }));
        g.beltY = lay.deckY + wm.l + 0.02;
        o.topMost = dims.yBot + dims.h + 0.03;
      } else if (k === 'hammersaw') {
        g.aL = 0.66 * s; g.P = { x: 0, y: A.y + 0.12, z: A.z };
        rotorPos = { x: 0, y: g.P.y + 0.02, z: g.P.z + g.aL };
        mpos = [{ x: 0.085, y: g.P.y, z: g.P.z, axis: 'x', side: 1, onArm: true }];
        o.topMost = g.P.y + g.aL * 0.55;
      } else if (axis === 'x') {
        g.halfX = (dims.Lw === undefined ? dims.t / 2 : dims.Lw / 2) + 0.03;
        g.yA = Math.max(baseY + tipR + 0.012, edge ? m.cy : 0) + (dims.tilt ? 0.03 : 0);
        g.zA = edge ? tipR + 0.03 : 0;
        rotorPos = { x: 0, y: g.yA, z: g.zA };
        const yM = edge ? Math.max(baseY + wm.d / 2 + 0.012, Math.min(m.cy, g.yA - 0.07)) : baseY + wm.d / 2 + 0.012;
        const zM = g.zA - Math.max(0.1, Math.min(tipR * 0.8, 0.17));
        g.xu = g.halfX + 0.012; // upright centre-line
        mpos = sides.map((sd) => ({ x: sd * (g.xu + 0.03 + wm.l / 2), y: yM, z: zM, axis: 'x', side: sd }));
        o.topMost = g.yA + Math.max(tipR, 0.05);
      } else {
        // horizontal bar / undercutter: vertical shaft on a boom (edge) or a mast (deck)
        if (edge) {
          g.yA = k === 'under' ? 0.034 : m.cy;
          g.zA = R + 0.07;
          g.plateY = g.yA + dims.t / 2 + (k === 'under' ? 0.05 : 0.04);
          g.beltY = g.yA + dims.t / 2 + 0.02;
          mpos = sides.map((sd) => ({ x: n === 1 ? 0 : sd * 0.1, y: g.plateY + 0.012 + wm.l / 2, z: 0.03 + wm.d / 2, axis: 'y', side: sd }));
          o.topMost = Math.max(g.plateY + 0.02 + wm.l, g.yA + 0.05);
        } else {
          g.beltY = baseY + wm.l + 0.02;
          g.yA = g.beltY + 0.035 + dims.t / 2;
          g.zA = 0;
          g.plateY = g.yA + dims.t / 2 + 0.04;
          mpos = sides.map((sd) => ({ x: n === 1 ? 0 : sd * 0.1, y: baseY + wm.l / 2 + 0.004, z: -(0.12 + wm.d / 2), axis: 'y', side: sd }));
          o.topMost = g.plateY + 0.02;
        }
        rotorPos = { x: 0, y: g.yA, z: g.zA };
      }
      g.rotorPos = rotorPos;
      const spin = simulateSpinner({ V: env.vNom, rPack: env.rPack, iPackMax: env.iPackMax, motor: wm, n, esc, ratio: md.ratio * (dims.gear || 1), eff: tr.eff, inertia, dragK, tipR });
      o.spin = spin;
      g.mass = mass; g.inertia = inertia;
      o.iPeak = spin.iPeak; o.iHold = spin.iHold;
      o.wh = (6 * spin.spinEnergyJ + env.vNom * spin.iHold * 150) / 3600;
      o.angMom = inertia * spin.wFinal;
      o.axis = axis;
      o.reaction = axis === 'y' ? spin.torqueStart : 0;
      part('rotor', def.name + (k === 'hammersaw' || k === 'saw' ? ' DISK' : ' ROTOR'), `S7 TOOL STEEL · ${f(mass * KG_TO_LB, 1)} LB · ${f(tipR * 2 * M_TO_IN, 1)} IN`, mass, rotorPos, 1, !!g.center);
      part('hub', 'SHAFT · HUB · BEARINGS', axis === 'y' ? '4340 DEAD SHAFT · TAPERED ROLLERS' : '4340 SHAFT · PILLOW BLOCKS', hubKg, rotorPos, 1, !!g.center);
      part('mount', 'WEAPON MOUNT', k === 'shell' ? 'CENTRE MAST' : k === 'ring' ? 'GUIDE ROLLERS x6' : k === 'drill' ? 'GEARBOX + THRUST BEARING' : axis === 'y' ? '7075 BOOM PLATES' : '7075 UPRIGHTS', k === 'shell' ? 3.5 : k === 'ring' ? 4.5 : 2.6 + mass * 0.06, g.center ? { x: 0, y: lay.cy, z: 0 } : { x: 0, y: rotorPos.y, z: (g.zA || A.z) * 0.5 }, 1, !!g.center);
      if (k === 'hammersaw') {
        part('arm', 'HAMMER ARM', '7075 BOX ARM · 150 DEG', 9.0, { x: 0, y: g.P.y + 0.03, z: g.P.z + g.aL / 2 });
        part('armdrive', 'ARM GEARMOTOR', 'PLANETARY SHOULDER DRIVE', 3.5, { x: -0.09, y: g.P.y, z: g.P.z });
      }
      motors(mpos.map((p) => (p.bot ? p : p)), 'WEAPON MOTOR');
      // shell motor positions are already in the bot frame
      if (g.center) { o.parts.filter((p) => p.id.includes(':motor')).forEach((p, i) => { p.pos = { x: mpos[i].x, y: mpos[i].y, z: mpos[i].z }; }); }
      part('trans', 'WEAPON TRANSMISSION', `${tr.name} · ${md.ratio.toFixed(2)}:1`, tr.kg, rotorPos, n, !!g.center);
      const tipMph = spin.tip * MS_TO_MPH;
      o.hero = { v: f(spin.ke / 1000, 1), u: 'KJ', l: 'STORED KINETIC ENERGY' };
      o.rows = [
        ['TIP SPEED', `${f(tipMph)} MPH<small>/ ${LIMITS.tipMph}</small>`, tipMph > LIMITS.tipMph],
        ['ROTOR SPEED', `${f(spin.rpm)} RPM`],
        ['SPIN-UP TO 90%', spin.t90 === null ? 'NEVER' : `${spin.t90.toFixed(1)} S`, spin.t90 === null || spin.t90 > 12],
        ['ROTOR', `${f(mass * KG_TO_LB, 1)} LB<small>${inertia.toFixed(2)} KG·M²</small>`],
        ['PEAK DRAW', `${f(spin.iPeak)} A<small>${f(spin.iHold)} A HOLD</small>`],
      ];
      chk('tip', 'TIP SPEED', tipMph <= LIMITS.tipMph ? 'pass' : 'fail', `${f(tipMph)} / ${LIMITS.tipMph} MPH`);
      chk('spin', 'SPIN-UP', spin.t90 === null ? 'fail' : spin.t90 <= 6 ? 'pass' : spin.t90 <= 12 ? 'warn' : 'fail', spin.t90 === null ? 'NEVER REACHES SPEED' : `${spin.t90.toFixed(1)} S TO 90%`);
      const holdLoad = spin.iHold / n / (wm.iMax * 0.4);
      chk('hold', 'MOTOR HOLD LOAD', holdLoad <= 1 ? 'pass' : holdLoad <= 1.4 ? 'warn' : 'fail', `${f(spin.iHold / n)} A HOLD VS ${f(wm.iMax * 0.4)} A CONT`);
      const need = Math.min(wm.iMax, env.iPackMax / n), have = esc.cont * ESC_BURST;
      chk('esci', 'ESC CURRENT', have >= need ? 'pass' : have >= need * 0.6 ? 'warn' : 'fail', have >= need ? `${f(have)} A BURST COVERS ${f(need)} A` : `LIMITS MOTOR TO ${f(have)} A OF ${f(need)} A`);
      o.loads.motor = Math.max(spin.iPeak / n / wm.iMax, holdLoad);
      o.loads.esc = spin.iPeak / n / have;
      o.action = { kind: 'spin', verb: 'SPIN' };
      if (k === 'drill') { o.hero = { v: f(spin.torqueStart), u: 'N·M', l: 'STALL TORQUE AT THE AUGER' }; o.action.verb = 'DRILL'; }
      if (k === 'ring') chk('ring', 'RING', 'info', 'SPINS AROUND THE HULL · EDGE HARDPOINTS AT RING HEIGHT ARE BLOCKED');
      if (k === 'shell') {
        const rd = env.ride;
        chk('shell', 'SHELL', 'info', 'ENCLOSES THE CHASSIS · SIDE HARDPOINTS MOVE ONTO THE SHELL');
        if (rd && rd.n) {
          const F = Math.hypot(rd.ub[0], rd.ub[1]) * spin.wFinal * spin.wFinal;
          const W = (LIMITS.weightLb / KG_TO_LB) * G;
          o.ride = { n: rd.n, I: rd.I, unbalanceN: F };
          chk('ride', 'RIDING MODULES', 'info', `${rd.n} SPIN WITH THE SHELL · +${rd.I.toFixed(2)} KG·M² INERTIA`);
          chk('bal', 'SHELL BALANCE', F < 0.5 * W ? 'pass' : F < 5 * W ? 'warn' : 'fail', F < 0.5 * W ? 'RIDING MODULES ARE BALANCED' : `${f(F / 1000, 1)} KN OUT OF BALANCE AT SPEED · MIRROR THE MODULE ON THE OPPOSITE SIDE`);
          o.rows[3] = ['RIDING MODULES', `${rd.n}<small>+${rd.I.toFixed(2)} KG·M²</small>`];
          if (rd.powered) {
            part('slip', 'SLIP RING', 'ROTARY POWER + SIGNAL COUPLING', 1.2, { x: 0, y: lay.deckY + 0.05, z: 0 }, 1, true);
            chk('slip', 'SLIP RING', 'info', 'POWERS THE MODULES THAT SPIN WITH THE SHELL');
          }
        }
        if (rd && rd.mast) {
          part('mast', 'STATIONARY MAST + PLATFORM', 'HOLLOW 4340 DEAD SHAFT · WIRED THROUGH THE BORE', 3.0, { x: 0, y: dims.yBot + dims.h + 0.04, z: 0 }, 1, true);
          chk('mast', 'TOP MAST', 'info', 'TOP MODULE STAYS STILL ON A HOLLOW CENTRE MAST');
        }
      }
    } else if (def.kind === 'hammer') {
      // electric hammer / axe: constant-torque swing through 150 degrees
      const aL = 0.6 * s, headKg = md.type === 'hammer' ? 6.5 * s : 4.2 * s, armKg = 5.5;
      g.aL = aL; g.P = { x: 0, y: A.y + 0.12, z: A.z }; g.head = md.type;
      const gear = 14 * md.ratio;
      const iLim = iLimEach(1);
      const kt = 60 / (2 * Math.PI * wm.kv);
      const tau = kt * iLim * gear * 0.85;
      const I = headKg * aL * aL + (armKg * aL * aL) / 3;
      const theta = 2.6;
      const wMax = (wm.kv * env.vNom * 2 * Math.PI) / 60 / gear;
      const w = Math.min(Math.sqrt((2 * tau * theta) / I), wMax);
      const E = 0.5 * I * w * w;
      o.hammer = { E, w, tau, swingS: (2 * theta) / Math.max(w, 0.1), tipSpeed: w * aL };
      o.iPeak = iLim; o.iHold = 0; o.wh = (25 * E * 2.2) / 3600;
      part('head', md.type === 'hammer' ? 'HAMMER HEAD' : 'AXE BLADE', 'S7 TOOL STEEL', headKg, { x: 0, y: g.P.y, z: g.P.z + aL });
      part('arm', 'SWING ARM', '7075 BOX SECTION', armKg, { x: 0, y: g.P.y, z: g.P.z + aL / 2 });
      part('mount', 'PIVOT TOWER + GEARBOX', `${gear.toFixed(0)}:1 REDUCTION`, 4.2, { x: 0, y: g.P.y - 0.05, z: g.P.z });
      motors([{ x: 0.1, y: g.P.y, z: g.P.z, axis: 'x', side: 1 }], 'HAMMER MOTOR');
      o.hero = { v: f(E / 1000, 2), u: 'KJ', l: 'ENERGY PER STRIKE' };
      o.rows = [
        ['HEAD SPEED', `${f(o.hammer.tipSpeed * MS_TO_MPH)} MPH`],
        ['SWING TIME', `${o.hammer.swingS.toFixed(2)} S`],
        ['SHOULDER TORQUE', `${f(tau)} N·M`],
        ['HEAD', `${f(headKg * KG_TO_LB, 1)} LB ON ${f(aL * M_TO_IN, 1)} IN ARM`],
        ['PEAK DRAW', `${f(iLim)} A`],
      ];
      o.loads.motor = iLim / wm.iMax; o.loads.esc = iLim / (esc.cont * ESC_BURST);
      o.topMost = g.P.y + aL;
      o.action = { kind: 'swing', verb: 'STRIKE' };
    } else if (def.kind === 'flipper') {
      const bore = 0.1 * s, stroke = 0.15, area = (Math.PI * bore * bore) / 4;
      const gas = GAS[md.gas], pBar = Math.min(md.pressure, gas.maxBar);
      const force = pBar * 1e5 * area * gas.force, energy = force * stroke;
      const perShot = pBar * area * stroke * 1000, usable = gas.usable(pBar);
      const shots = Math.max(0, Math.floor(usable / perShot));
      Object.assign(g, { bore, stroke, H: { x: 0, y: A.y + 0.075, z: A.z - 0.1 }, plateLen: edge ? m.inset + 0.33 : 0.42, plateW: Math.min(2 * m.halfW * 0.62, 0.5) });
      o.flip = { force, energy, shots, pressureBar: pBar, perShot, launchM: (energy * 0.5) / ((LIMITS.weightLb / KG_TO_LB) * G) };
      o.iPeak = 3; o.wh = 2;
      part('arm', 'FLIPPER ARM', 'AR500 PLATE + SCOOP LIP', 9.0 * s, { x: 0, y: g.H.y, z: g.H.z + g.plateLen / 2 });
      part('cyl', 'PNEUMATIC RAM', `${f(bore * 1000)} MM BORE · ${f(stroke * 1000)} MM STROKE`, 3.5 * s * s, { x: 0, y: A.y + 0.04, z: g.H.z + 0.12 });
      part('tank', gas.tank, gas.spec, gas.tankKg, { x: g.plateW / 2 + 0.07, y: A.y + 0.06, z: g.H.z + 0.1 });
      part('buffer', 'BUFFER + DUMP VALVE', `${f(pBar)} BAR`, 3.2, { x: -(g.plateW / 2 + 0.07), y: A.y + 0.06, z: g.H.z + 0.1 });
      o.hero = { v: f(energy / 1000, 1), u: 'KJ', l: 'ENERGY PER SHOT' };
      o.rows = [
        ['RAM FORCE', `${f(force / 1000, 1)} KN<small>${f(force * N_TO_LBF)} LBF</small>`],
        ['FULL-POWER SHOTS', `${shots}`, shots < 6],
        ['LAUNCH · 250 LB BOT', `${o.flip.launchM.toFixed(1)} M<small>${f(o.flip.launchM * 3.28084, 1)} FT</small>`],
        ['BUFFER', `${f(pBar)} BAR<small>${f(pBar * 14.5038)} PSI</small>`],
        ['RAM', `${f(bore * 1000)} × ${f(stroke * 1000)} MM`],
        ['GAS', gas.name],
      ];
      if (shots < 6) chk('shots', 'GAS SUPPLY', 'warn', `ONLY ${shots} FULL-POWER SHOTS`);
      if (md.gas === 'co2') chk('gas', 'GAS', 'info', 'CO2: MORE SHOTS PER FILL · LESS FORCE AS THE TANK CHILLS');
      o.topMost = A.y + 0.1;
      o.action = { kind: 'fire', verb: 'FIRE' };
    } else if (def.kind === 'punch') {
      // straight-line ram: the cylinder lies along the outward axis and drives a hardened spike
      const bore = 0.08 * s, stroke = 0.2 * s, area = (Math.PI * bore * bore) / 4;
      const gas = GAS[md.gas], pBar = Math.min(md.pressure, gas.maxBar);
      const force = pBar * 1e5 * area * gas.force, energy = force * stroke;
      const perShot = pBar * area * stroke * 1000, shots = Math.max(0, Math.floor(gas.usable(pBar) / perShot));
      const movingKg = 3.0 * s;
      Object.assign(g, { bore, stroke, bodyL: stroke + 0.08, spikeL: 0.11, Pn: { x: 0, y: edge ? Math.max(m.cy, bore / 2 + 0.03) : A.y + bore / 2 + 0.035, z: edge ? 0.0 : -0.2 } });
      o.punch = { force, energy, shots, pressureBar: pBar, v: Math.sqrt((2 * energy) / movingKg) };
      o.iPeak = 3; o.wh = 2;
      part('ram', 'PUNCH RAM', `${f(bore * 1000)} MM BORE · ${f(stroke * 1000)} MM STROKE`, 4.4 * s * s, { x: 0, y: g.Pn.y, z: g.Pn.z + g.bodyL / 2 });
      part('spike', 'PUNCH SPIKE', 'S7 TOOL STEEL · HARDENED TIP', movingKg, { x: 0, y: g.Pn.y, z: g.Pn.z + g.bodyL + 0.05 });
      part('tank', gas.tank, gas.spec, gas.tankKg, { x: 0.1, y: A.y + 0.06, z: A.z });
      part('buffer', 'BUFFER + DUMP VALVE', `${f(pBar)} BAR`, 2.8, { x: -0.1, y: A.y + 0.06, z: A.z });
      o.hero = { v: f(energy / 1000, 1), u: 'KJ', l: 'ENERGY PER PUNCH' };
      o.rows = [
        ['RAM FORCE', `${f(force / 1000, 1)} KN<small>${f(force * N_TO_LBF)} LBF</small>`],
        ['SPIKE SPEED', `${f(o.punch.v * MS_TO_MPH)} MPH`],
        ['FULL-POWER SHOTS', `${shots}`, shots < 6],
        ['BUFFER', `${f(pBar)} BAR<small>${f(pBar * 14.5038)} PSI</small>`],
        ['RAM', `${f(bore * 1000)} × ${f(stroke * 1000)} MM`],
        ['GAS', gas.name],
      ];
      if (shots < 6) chk('shots', 'GAS SUPPLY', 'warn', `ONLY ${shots} FULL-POWER SHOTS`);
      if (md.gas === 'co2') chk('gas', 'GAS', 'info', 'CO2: MORE SHOTS PER FILL · LESS FORCE AS THE TANK CHILLS');
      o.topMost = Math.max(g.Pn.y + bore / 2 + 0.03, A.y + 0.13);
      o.action = { kind: 'fire', verb: 'PUNCH' };
    } else if (def.kind === 'lifter') {
      // lifter: forks only · grablift: forks + clamp jaw · suplex: clamps and carries the load over the top
      const k = md.type, hasClamp = k !== 'lifter', sup = k === 'suplex';
      const armL = (sup ? 0.44 : 0.34) * s, gear = (sup ? 90 : 60) * md.ratio;
      const iLim = iLimEach(1), kt = 60 / (2 * Math.PI * wm.kv);
      const tau = kt * iLim * gear * 0.8;
      const liftKg = tau / armL / G;
      const wArm = (wm.kv * env.vNom * 2 * Math.PI) / 60 / gear;
      const sweepA = sup ? 2.7 : 1.2;
      Object.assign(g, { armL, sweep: sweepA, clamp: hasClamp, H: { x: 0, y: A.y + 0.05, z: edge ? -m.inset - 0.03 : 0 } });
      o.lift = { tau, liftKg, timeS: sweepA / Math.max(wArm * 0.6, 0.1) };
      o.iPeak = iLim * 0.6; o.wh = sup ? 9 : 6;
      part('arm', sup ? 'SUPLEX ARM + FORKS' : 'LIFTING FORKS', 'S7 TINES · 7075 CARRIER', (sup ? 8.5 : 6.5) * s, { x: 0, y: g.H.y, z: g.H.z + armL / 2 });
      part('mount', 'LIFT GEARBOX', `${gear.toFixed(0)}:1 WORM + PLANETARY`, 3.4, { x: 0, y: g.H.y, z: g.H.z });
      if (hasClamp) {
        o.grab = { force: 2400 * s };
        part('clamp', 'CLAMP JAW', 'AR500 UPPER JAW · LINEAR ACTUATOR', 3.4 * s, { x: 0, y: g.H.y + 0.12, z: g.H.z + armL * 0.6 });
      }
      motors([{ x: 0.11, y: g.H.y, z: g.H.z, axis: 'x', side: 1 }], 'LIFT MOTOR');
      o.hero = { v: f(liftKg * KG_TO_LB), u: 'LB', l: sup ? 'THROW CAPACITY AT TIP' : 'LIFT CAPACITY AT TIP' };
      o.rows = [['SHAFT TORQUE', `${f(tau)} N·M`], [sup ? 'THROW TIME' : 'LIFT TIME', `${o.lift.timeS.toFixed(1)} S`], ['FORK REACH', `${f(armL * M_TO_IN, 1)} IN`], ['PEAK DRAW', `${f(o.iPeak)} A`]];
      if (hasClamp) o.rows.push(['CLAMP FORCE', `${f(o.grab.force / 1000, 1)} KN<small>${f(o.grab.force * N_TO_LBF)} LBF</small>`]);
      if (sup) o.rows.push(['ARM SWEEP', `${f((sweepA * 180) / Math.PI)} DEG`]);
      if (liftKg * KG_TO_LB < 250) chk('lift', 'LIFT CAPACITY', 'warn', `${f(liftKg * KG_TO_LB)} LB · CANNOT LIFT A 250 LB BOT`);
      o.loads.motor = iLim / wm.iMax; o.loads.esc = iLim / (esc.cont * ESC_BURST);
      o.topMost = g.H.y + armL + (hasClamp ? 0.12 : 0);
      o.action = { kind: 'toggle', verb: sup ? 'SUPLEX' : hasClamp ? 'GRAB + LIFT' : 'LIFT', back: sup ? 'RESET' : 'LOWER', timeS: o.lift.timeS };
    } else if (def.kind === 'crusher') {
      const bore = 0.063 * s, stroke = 0.12, area = (Math.PI * bore * bore) / 4;
      const iLim = iLimEach(1);
      const pElec = env.vNom * iLim * 0.8, pPa = 690e5;
      const flow = (pElec * 0.8) / pPa;
      const cylForce = pPa * area;
      Object.assign(g, { bore, P: { x: 0, y: A.y + 0.06, z: A.z + 0.06 }, reach: (edge ? -A.z : 0.2) + 0.1 });
      o.crush = { cylForce, tipForce: cylForce * 0.45, closeS: (area * stroke) / flow, pumpKw: pElec / 1000, pressureBar: 690 };
      o.iPeak = iLim; o.iHold = iLim * 0.3; o.wh = (env.vNom * iLim * 0.8 * o.crush.closeS * 8) / 3600;
      part('beak', 'CRUSHER BEAK ARM', 'AR500 · PIERCING TIP', 14 * s, { x: 0, y: g.P.y + 0.1, z: g.P.z + g.reach * 0.5 });
      part('jaw', 'LOWER JAW', 'S7 TOOL STEEL', 6 * s, { x: 0, y: edge ? 0.04 : A.y + 0.02, z: g.P.z + g.reach });
      part('cyl', 'HYDRAULIC CYLINDER', `${f(bore * 1000)} MM BORE · 690 BAR`, 6 * s * s, { x: 0, y: A.y + 0.05, z: g.P.z - 0.14 });
      part('pump', 'PUMP + RESERVOIR', 'GEAR PUMP · 1.5 L OIL', 5.5, { x: -0.11, y: A.y + 0.05, z: g.P.z - 0.2 });
      motors([{ x: 0.11, y: A.y + wm.d / 2 + 0.01, z: g.P.z - 0.2, axis: 'z', side: 1 }], 'PUMP MOTOR');
      o.hero = { v: f(o.crush.tipForce / 9806.65, 1), u: 'TONNE-F', l: 'FORCE AT BEAK TIP' };
      o.rows = [
        ['TIP FORCE', `${f(o.crush.tipForce / 1000, 1)} KN<small>${f(o.crush.tipForce * N_TO_LBF)} LBF</small>`],
        ['CLOSE TIME', `${o.crush.closeS.toFixed(1)} S`, o.crush.closeS > 8],
        ['SYSTEM PRESSURE', '690 BAR<small>10,008 PSI</small>'],
        ['PUMP INPUT', `${o.crush.pumpKw.toFixed(1)} KW`],
        ['PEAK DRAW', `${f(iLim)} A`],
      ];
      o.loads.motor = iLim / wm.iMax; o.loads.esc = iLim / (esc.cont * ESC_BURST);
      o.topMost = g.P.y + 0.2;
      o.action = { kind: 'toggle', verb: 'CLOSE', back: 'OPEN', timeS: o.crush.closeS };
    } else if (def.kind === 'grabber') {
      const armL = 0.3 * s, tau = 260 * s;
      Object.assign(g, { armL, halfW: Math.min(m.halfW - 0.04, 0.24), y: edge ? Math.max(0.08, m.cy) : A.y + 0.06, z: edge ? 0.02 : 0 });
      o.grab = { force: tau / armL };
      o.iPeak = 60; o.wh = 4;
      part('claws', 'CLAMP ARMS', 'AR500 CLAWS x2', 4.2 * s, { x: 0, y: g.y, z: g.z + armL / 2 }, 2);
      part('drive', 'CLAW GEARMOTORS', '90:1 PLANETARY x2 + DRIVER', 2.1, { x: 0, y: g.y, z: g.z }, 2);
      o.hero = { v: f(o.grab.force * N_TO_LBF), u: 'LBF', l: 'CLAMP FORCE PER CLAW' };
      o.rows = [['CLAW REACH', `${f(armL * M_TO_IN, 1)} IN`], ['JAW OPENING', `${f(g.halfW * 2 * M_TO_IN, 1)} IN`], ['CLOSE TIME', '0.4 S'], ['PEAK DRAW', '60 A']];
      o.topMost = g.y + 0.06;
      o.action = { kind: 'toggle', verb: 'CLAMP', back: 'RELEASE', timeS: 0.4 };
    } else if (def.kind === 'flame') {
      const flow = 0.012 * s * s, fuelKg = 0.45;
      Object.assign(g, { T: { x: 0, y: A.y, z: A.z }, barrel: 0.3 * s, payload: 'flame' });
      o.flame = { flow, kw: flow * 46400, burnS: fuelKg / flow, rangeM: 1.3 * s };
      o.iPeak = 4; o.wh = 1;
      part('turret', 'FLAME TURRET', 'YAW BASE · NOZZLE · PILOT IGNITER', 3.4 * s, { x: 0, y: A.y + 0.08, z: A.z });
      part('fuel', 'PROPANE BOTTLE + REGULATOR', `${f(fuelKg * 1000)} G FUEL`, 1.9, { x: 0.1, y: A.y + 0.06, z: A.z - 0.05 });
      part('valve', 'SOLENOID + FLASHBACK ARRESTOR', '24 V', 0.7, { x: -0.08, y: A.y + 0.05, z: A.z });
      o.hero = { v: f(o.flame.kw), u: 'KW', l: 'THERMAL OUTPUT' };
      o.rows = [['FUEL FLOW', `${f(flow * 1000, 1)} G/S`], ['BURN TIME', `${f(o.flame.burnS)} S`], ['FLAME REACH', `${o.flame.rangeM.toFixed(1)} M<small>${f(o.flame.rangeM * 3.28084, 1)} FT</small>`], ['FUEL LOAD', `${f(fuelKg * 1000)} G PROPANE`]];
      o.topMost = A.y + 0.2;
      legal();
      o.action = { kind: 'burn', verb: 'IGNITE' };
    } else if (def.kind === 'arc') {
      const E = 2000 * s * s, chargeW = 1500;
      Object.assign(g, { T: { x: 0, y: A.y, z: A.z }, barrel: 0.3 * s, payload: 'arc' });
      o.arc = { E, rechargeS: E / chargeW / 0.8, kv: 40 };
      o.iPeak = chargeW / env.vNom; o.wh = (chargeW * 60) / 3600;
      part('turret', 'ARC EMITTER HEAD', 'TWIN ELECTRODES · INSULATOR STACK', 2.8 * s, { x: 0, y: A.y + 0.1, z: A.z + 0.05 });
      part('caps', 'CAPACITOR BANK', `${f(E)} J STORED`, 3.6 * s * s, { x: 0, y: A.y + 0.06, z: A.z - 0.1 });
      part('hv', 'HV CONVERTER', `${chargeW} W CHARGER`, 1.5, { x: 0.09, y: A.y + 0.05, z: A.z - 0.02 });
      o.hero = { v: f(E / 1000, 1), u: 'KJ', l: 'STORED PER DISCHARGE' };
      o.rows = [['RECHARGE', `${o.arc.rechargeS.toFixed(1)} S`], ['OUTPUT', `${f(o.arc.kv * 1000)} V OPEN-CIRCUIT`], ['CHARGE DRAW', `${f(o.iPeak)} A`], ['GAP', `${f(0.06 * s * 1000)} MM`]];
      o.topMost = A.y + 0.24;
      legal();
      o.action = { kind: 'arc', verb: 'DISCHARGE' };
    } else if (def.kind === 'launcher') {
      const k = md.type;
      Object.assign(g, { T: { x: 0, y: A.y, z: A.z }, barrel: (k === 'net' ? 0.16 : k === 'cannon' ? 0.46 : 0.4) * s, payload: k });
      let E, mProj, shots, kg, spec, extra = [];
      if (k === 'spike') { const area = Math.PI * 0.02 * 0.02; E = 60e5 * area * g.barrel; mProj = 0.8; shots = Math.floor(((300 - 60) * 2) / (60 * area * g.barrel * 1000)); kg = 5.8 * s; spec = 'PNEUMATIC · TETHERED RETURN'; extra = [['SUPPLY', '2 L · 300 BAR N2'], ['TETHER', '3 M BRAIDED STEEL']]; o.iPeak = 3; }
      else if (k === 'net') { E = 400; mProj = 0.35; shots = 4; kg = 4.4 * s; spec = 'CO2 · WEIGHTED NET'; extra = [['SPREAD', '1.5 M NET'], ['BARRELS', '4']]; o.iPeak = 3; }
      else if (k === 'coil') { const cap = 3000 * s * s; E = cap * 0.04; mProj = 0.1; shots = 40; kg = 7.6 * s; spec = '5 STAGE · 4% EFFICIENT'; extra = [['CAPACITOR BANK', `${f(cap)} J`], ['RECHARGE', `${(cap / 1200).toFixed(1)} S`]]; o.iPeak = 1500 / env.vNom; o.wh = 8; }
      else if (k === 'harpoon') { const area = Math.PI * 0.025 * 0.025; E = 60e5 * area * g.barrel; mProj = 1.4; shots = Math.floor(((300 - 60) * 2) / (60 * area * g.barrel * 1000)); kg = 6.4 * s; spec = 'PNEUMATIC · BARBED HEAD'; extra = [['WINCH PULL', '1,800 N'], ['CABLE', '4 M BRAIDED STEEL'], ['REEL-IN', '2.5 S']]; o.iPeak = 45; o.wh = 3; }
      else { E = 1800; mProj = 0.045; shots = 30; kg = 9.4 * s; spec = 'SIMULATED · DRUM FED'; extra = [['RATE', '5 ROUNDS / S'], ['FEED', '30 ROUND DRUM']]; o.iPeak = 8; }
      const v = Math.sqrt((2 * E * (k === 'spike' || k === 'harpoon' ? 0.6 : 1)) / mProj);
      o.launch = { E, v, shots, mProj };
      part('turret', def.name, spec, kg, { x: 0, y: A.y + 0.1, z: A.z + 0.04 });
      part('feed', k === 'harpoon' ? 'WINCH + GAS SUPPLY' : k === 'spike' || k === 'net' ? 'GAS SUPPLY' : k === 'coil' ? 'CAPACITOR BANK' : 'AMMO DRUM + FEED', k === 'cannon' ? '30 ROUNDS' : k === 'harpoon' ? 'GEARED REEL · 2 L N2' : 'ONBOARD', k === 'coil' ? 3.2 * s : k === 'harpoon' ? 3.6 : 2.2, { x: 0.08, y: A.y + 0.06, z: A.z - 0.08 });
      o.hero = { v: f(E), u: 'J', l: 'MUZZLE ENERGY' };
      o.rows = [['MUZZLE VELOCITY', `${f(v)} M/S<small>${f(v * MS_TO_MPH)} MPH</small>`], ['PROJECTILE', `${f(mProj * 1000)} G`], ['SHOTS', `${shots}`], ...extra];
      o.topMost = A.y + 0.22;
      legal();
      o.action = { kind: 'shoot', verb: 'FIRE' };
    } else if (def.kind === 'srimech') {
      Object.assign(g, { H: { x: 0, y: A.y + 0.03, z: A.z }, armL: Math.min(0.5, 0.42 * s + 0.05) });
      o.iPeak = 40; o.wh = 1;
      part('arm', 'SELF-RIGHTING ARM', '7075 ARM · 180 DEG', 2.6 * s, { x: 0, y: g.H.y, z: g.H.z + g.armL / 2 });
      part('servo', 'HV SERVO GEARMOTOR', '300 KG·CM', 1.1, { x: 0.08, y: g.H.y, z: g.H.z });
      o.hero = { v: '180', u: 'DEG', l: 'ARM SWEEP' };
      o.rows = [['ARM LENGTH', `${f(g.armL * M_TO_IN, 1)} IN`], ['FUNCTION', 'RIGHTS THE BOT WHEN FLIPPED']];
      o.selfRight = true;
      o.topMost = A.y + 0.07;
      o.action = { kind: 'toggle', verb: 'SWEEP', back: 'STOW', timeS: 0.5 };
    } else if (def.kind === 'melty') {
      // the controller only; the spin numbers need the finished bot and are filled in by compute()
      Object.assign(g, { C: { x: 0, y: A.y, z: A.z } });
      o.melty = true;
      o.iPeak = 2; o.wh = 1;
      part('brain', 'MELTY CONTROLLER', 'ACCELEROMETER · HEADING SOLVER', 0.25, { x: 0, y: A.y + 0.025, z: A.z });
      part('beacon', 'HEADING BEACON', 'LED BAR MARKS THE "FRONT" WHILE SPINNING', 0.2, { x: 0, y: A.y + 0.05, z: A.z + 0.05 });
      o.topMost = A.y + 0.075;
      o.action = { kind: 'spin', verb: 'SPIN UP', whole: true };
    } else {
      // passive tools
      const k = md.type;
      const w = 2 * m.halfW;
      g.w = w;
      let kg, name = def.name, spec;
      if (k === 'forks') { kg = 2.4 * s; spec = 'S7 TOOL STEEL x4'; }
      else if (k === 'plow') { kg = Math.max(4, w * 0.2 * 0.006 * RHO_STEEL * 1.3) * s; spec = 'AR500 · 6 MM'; }
      else if (k === 'ramp') { kg = Math.max(5, w * 0.3 * 0.006 * RHO_STEEL) * s; spec = 'AR500 SCOOP · 6 MM'; }
      else if (k === 'tail') { kg = 5.5 * s; spec = 'S7 HEAD · SPRING-STEEL BOOM'; g.tailL = 0.42 * s; }
      else { kg = 3.3 * s; spec = 'S7 CONES x3'; }
      const y = edge ? (k === 'spikes' || k === 'tail' ? m.cy : 0.05) : A.y + 0.03;
      part('tool', name, spec, kg, { x: 0, y, z: k === 'tail' ? (edge ? 0 : A.z) + g.tailL * 0.7 : edge ? 0.1 : 0 });
      o.hero = { v: f(kg * KG_TO_LB, 1), u: 'LB', l: 'PASSIVE ATTACHMENT' };
      o.rows = [['WIDTH', `${f((k === 'spikes' ? 0.3 : w * 0.94) * M_TO_IN, 1)} IN`], ['FUNCTION', k === 'spikes' ? 'RAMMING DAMAGE' : k === 'forks' ? 'GET UNDER OPPONENTS' : 'DEFLECT SPINNERS']];
      o.topMost = edge ? (k === 'spikes' ? m.cy + 0.03 : 0.16) : A.y + 0.06;
      if (k === 'tail') { o.rows = [['LENGTH', `${f(g.tailL * M_TO_IN, 1)} IN`], ['FUNCTION', 'HITS WHEN THE BOT SPINS']]; o.topMost = edge ? m.cy + 0.05 : A.y + 0.1; }
    }
    o.mass = o.parts.reduce((a, p) => a + p.total, 0);
    return o;
  }

  // ---------------------------------------------------------------------------
  // INTERFERENCE — the space each module needs through its whole range of motion
  // ---------------------------------------------------------------------------
  // Returns { solid: [...], fire: [...] } as axis-aligned boxes [x0, x1, y0, y1, z0, z1] in the bot frame.
  // `solid` is hardware plus everything it sweeps (a flipper's arc, a hammer's swing, a rotor's disc);
  // `fire` is the line of fire of a turret, which must stay clear of other hardware.
  function envelope(o) {
    const g = o.geo, m = o.mount, md = o.md, k = o.type, s = g.s, edge = g.edge;
    const wm = WEAPON_MOTORS[md.motor];
    const solid = [], fire = [];
    if (g.ring) return { solid: [[g.R - 0.03, g.tipR, g.yA - 0.035, g.yA + 0.035, -0.02, 0.02]], fire, spinY: true };
    if (g.center) return { solid, fire };
    const push = (list, x0, x1, y0, y1, z0, z1) => {
      let bx0 = 1e9, bx1 = -1e9, bz0 = 1e9, bz1 = -1e9;
      for (const x of [x0, x1]) for (const z of [z0, z1]) { const p = toBot(m, { x, y: 0, z }); bx0 = Math.min(bx0, p.x); bx1 = Math.max(bx1, p.x); bz0 = Math.min(bz0, p.z); bz1 = Math.max(bz1, p.z); }
      list.push([bx0, bx1, Math.min(y0, y1), Math.max(y0, y1), bz0, bz1]);
    };
    const box = (x0, x1, y0, y1, z0, z1) => push(solid, x0, x1, y0, y1, z0, z1);
    const zr = -(m.inset + 0.02);
    const A = g.A;
    // arm of the given radii swinging about a lateral pivot from angle a0 to a1 (measured from +z up toward +y)
    const arc = (py, pz, a0, a1, radii, hs, hx, n) => {
      for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; for (const r of radii) box(-hx, hx, py + Math.sin(a) * r - hs, py + Math.sin(a) * r + hs, pz + Math.cos(a) * r - hs, pz + Math.cos(a) * r + hs); }
    };
    // rigid outline (points [z, y] relative to the pivot at rest) raised through an angle
    const sweep = (py, pz, pts, aMax, hs, hx, n) => {
      for (let i = 0; i <= n; i++) { const a = (aMax * i) / n, c = Math.cos(a), sn = Math.sin(a); for (const p of pts) { const z = p[0] * c - p[1] * sn, y = p[0] * sn + p[1] * c; box(-hx, hx, py + y - hs, py + y + hs, pz + z - hs, pz + z + hs); } }
    };
    const motorBoxes = (axis) => o.motorPos.forEach((p) => { const hl = wm.l / 2, hd = wm.d / 2; if (axis === 'x') box(p.x - hl, p.x + hl, p.y - hd, p.y + hd, p.z - hd, p.z + hd); else if (axis === 'y') box(p.x - hd, p.x + hd, p.y - hl, p.y + hl, p.z - hd, p.z + hd); else box(p.x - hd, p.x + hd, p.y - hd, p.y + hd, p.z - hl, p.z + hl); });

    if (o.kind === 'spinner' && g.axis === 'z') {
      box(-g.R - 0.01, g.R + 0.01, g.yA - g.R - 0.01, g.yA + g.R + 0.01, edge ? zr : g.zA - 0.1, g.zA + g.Lb + 0.02);
      motorBoxes('z');
    } else if (o.kind === 'spinner' && g.axis === 'x') {
      const hx = g.tilt ? g.tipR * Math.sin(g.tilt) + g.xu * Math.cos(g.tilt) + 0.02 : g.xu + 0.02;
      box(-hx, hx, g.yA - g.tipR, g.yA + g.tipR, g.zA - g.tipR, g.zA + g.tipR);
      motorBoxes('x');
      if (edge) box(-g.xu, g.xu, m.cy - 0.065, m.cy + 0.065, zr, g.zA); else box(-g.xu - 0.03, g.xu + 0.03, g.baseY, g.yA, g.zA - 0.11, g.zA + 0.11);
    } else if (o.kind === 'spinner') {
      box(-g.R, g.R, g.yA - g.t / 2 - 0.01, g.yA + g.t / 2 + 0.01, g.zA - g.R, g.zA + g.R);
      motorBoxes('y');
      if (edge) box(-0.15, 0.15, g.plateY - 0.006, g.plateY + 0.012, zr, g.zA + 0.07); else box(-0.09, 0.09, g.baseY, g.plateY + 0.02, g.zA - 0.09, g.zA + 0.09);
    } else if (o.kind === 'hammer' || o.kind === 'armsaw') {
      const P = g.P, aL = g.aL, saw = o.kind === 'armsaw';
      arc(P.y, P.z, saw ? -0.24 : -0.14, saw ? 0.95 : 2.6, [aL * 0.35, aL * 0.68], 0.06, 0.07, 10);
      arc(P.y + (saw ? 0.02 : 0), P.z, saw ? -0.24 : -0.14, saw ? 0.95 : 2.6, [aL], saw ? g.R + 0.02 : 0.12, saw ? 0.09 : 0.07, 14);
      box(-0.14, 0.12 + wm.l, A.y, P.y + 0.05, P.z - 0.1, P.z + 0.1);
    } else if (o.kind === 'flipper') {
      const H = g.H, pl = g.plateLen, pw = g.plateW;
      const pts = [[pl * 0.2, 0], [pl * 0.45, 0], [pl * 0.7, 0], [pl * 0.95, 0]];
      if (edge) { const tipY = 0.018 - H.y, lipZ = pl + Math.min(0.14, -tipY * 0.7); pts.push([(pl + lipZ) / 2, tipY * 0.5], [lipZ, tipY + 0.04]); }
      sweep(H.y, H.z, pts, 1.05, 0.055, pw / 2, 6);
      for (const sx of [-1, 1]) box(sx * (pw / 2 + 0.02), sx * (pw / 2 + 0.135), A.y, A.y + 0.12, H.z - 0.03, H.z + 0.3);
    } else if (o.kind === 'punch') {
      const P = g.Pn;
      box(-0.065, 0.065, P.y - 0.065, P.y + 0.065, edge ? zr : P.z - 0.02, P.z + g.bodyL + g.spikeL + g.stroke);
      for (const sx of [-1, 1]) box(sx * 0.045, sx * 0.155, A.y, A.y + 0.12, A.z - 0.11, A.z + 0.11);
    } else if (o.kind === 'melty') {
      box(-0.07, 0.07, A.y, A.y + 0.075, A.z - 0.06, A.z + 0.09);
    } else if (o.kind === 'lifter') {
      const H = g.H, aL = g.armL, drop = edge ? H.y - 0.014 : 0.03;
      const pts = edge ? [[0.04, -drop * 0.5], [0.05, -drop + 0.03], [aL * 0.5, -drop + 0.03], [aL, -drop + 0.03]] : [[aL * 0.3, 0], [aL * 0.65, 0], [aL, 0]];
      if (g.clamp) { const yb = edge ? -drop + 0.03 : 0; pts.push([aL * 0.35, yb + 0.17], [aL * 0.7, yb + 0.15], [aL, yb + 0.1]); }
      sweep(H.y, H.z, pts, g.sweep, 0.045, 0.17, Math.ceil(g.sweep / 0.2));
      box(-0.06, 0.13 + wm.l / 2, H.y - 0.05, H.y + 0.05, H.z - 0.1, H.z + 0.02);
    } else if (o.kind === 'crusher') {
      const P = g.P, reach = g.reach, jawY = edge ? 0.04 : A.y + 0.02, tipY = jawY + 0.02 - P.y;
      sweep(P.y, P.z, [[-0.08, 0.06], [0.02, 0.1], [reach * 0.5, 0.17], [reach * 0.9, 0.12], [reach + 0.02, 0.0], [reach, tipY * 0.5], [reach, tipY + 0.04]], 0.62, 0.05, 0.035, 5);
      box(-0.06, 0.06, jawY - 0.03, jawY + 0.015, edge ? zr : P.z - 0.02, P.z + reach + 0.06);
      box(-0.15, 0.13 + wm.d / 2, A.y, A.y + 0.2, P.z - 0.3, P.z - 0.05);
    } else if (o.kind === 'grabber') {
      const ext = g.halfW + 0.05 + g.armL * 0.5;
      box(-ext, ext, g.y - 0.11, g.y + 0.08, g.z - 0.03, g.z + 0.04 + g.armL);
    } else if (g.T) {
      const T = g.T, bl = g.barrel, top = T.y + (g.payload === 'arc' ? 0.25 + bl * 0.5 : 0.19);
      box(-0.15, 0.15, T.y, top, T.z - 0.17, T.z + 0.12);
      box(-0.05, 0.05, T.y + 0.06, top - 0.03, T.z + 0.1, T.z + 0.14 + bl);
      const range = g.payload === 'flame' ? o.flame.rangeM * 0.6 : 0.6;
      push(fire, -0.04, 0.04, T.y + 0.075, T.y + 0.145, T.z + 0.14 + bl, T.z + 0.14 + bl + range);
    } else if (o.kind === 'srimech') {
      arc(g.H.y, g.H.z, 0.1, Math.PI - 0.06, [g.armL * 0.5, g.armL], 0.04, 0.05, 10);
      box(-0.05, 0.11, A.y, A.y + 0.06, g.H.z - 0.04, g.H.z + 0.04);
    } else {
      const w = (Math.min(g.w, 1.0) * 0.94) / 2, cy = m.cy, dy = A.y;
      if (k === 'forks') {
        if (edge) { box(-w, w, cy - 0.04, cy + 0.04, zr, 0.08); box(-w, w, 0, cy * 0.7, 0.06, 0.16 * s); box(-w, w, 0, 0.05, 0.16 * s, 0.26 * s); }
        else box(-w, w, dy, dy + 0.06, A.z - 0.03, A.z + 0.29 * s);
      } else if (k === 'plow' || k === 'ramp') {
        const reach = (k === 'plow' ? 0.17 : 0.3) * s;
        if (edge) box(-w, w, 0, k === 'plow' ? Math.max(cy + 0.07, 0.15) : cy + 0.03, 0, reach + 0.03);
        else box(-w, w, dy, dy + (k === 'plow' ? 0.14 : 0.08), A.z - 0.02, A.z + reach + 0.02);
      } else if (k === 'tail') {
        if (edge) box(-0.07, 0.07, cy - 0.06, cy + 0.06, 0, g.tailL + 0.07); else box(-0.07, 0.07, dy, dy + 0.11, A.z - 0.05, A.z + g.tailL + 0.07);
      } else if (edge) box(-0.17, 0.17, cy - 0.05, cy + 0.05, 0, 0.19 * s);
      else box(-0.17, 0.17, dy, dy + 0.06 + 0.14 * s, A.z - 0.05, A.z + 0.05);
    }
    return { solid, fire };
  }

  const boxesHit = (a, b, e) => a[0] < b[1] - e && b[0] < a[1] - e && a[2] < b[3] - e && b[2] < a[3] - e && a[4] < b[5] - e && b[4] < a[5] - e;
  // something that spins about the vertical axis occupies a ring; compare it with a box that stays still
  function ringHit(spinBox, stillBox) {
    if (!(spinBox[2] < stillBox[3] - 0.004 && stillBox[2] < spinBox[3] - 0.004)) return false;
    const span = (b) => {
      const nx = b[0] <= 0 && b[1] >= 0 ? 0 : Math.min(Math.abs(b[0]), Math.abs(b[1])), nz = b[4] <= 0 && b[5] >= 0 ? 0 : Math.min(Math.abs(b[4]), Math.abs(b[5]));
      return [Math.hypot(nx, nz), Math.hypot(Math.max(Math.abs(b[0]), Math.abs(b[1])), Math.max(Math.abs(b[4]), Math.abs(b[5])))];
    };
    const r = span(spinBox), q = span(stillBox);
    return r[0] < q[1] - 0.004 && q[0] < r[1] - 0.004;
  }
  // every pair of modules that cannot physically coexist
  function findConflicts(mods, active) {
    const out = [];
    for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
      const a = mods[active[i]], b = mods[active[j]];
      const spinA = !!a.mount.onShell || !!a.env.spinY, spinB = !!b.mount.onShell || !!b.env.spinY;
      const centre = (o) => o.type === 'shell' || o.type === 'ring';
      if (centre(a) && centre(b)) { out.push({ a: a.slot, b: b.slot, kind: 'collide', text: `${SLOT_NAMES[a.slot]} ${a.def.name} AND ${SLOT_NAMES[b.slot]} ${b.def.name} NEED THE SAME SPACE` }); continue; }
      const hit = (la, lb) => la.some((p) => lb.some((q) => (spinA === spinB ? boxesHit(p, q, 0.004) : spinA ? ringHit(p, q) : ringHit(q, p))));
      let kind = null;
      if (hit(a.env.solid, b.env.solid)) kind = 'collide';
      else if (hit(a.env.fire, b.env.solid)) kind = 'fireA';
      else if (hit(b.env.fire, a.env.solid)) kind = 'fireB';
      if (!kind) continue;
      const A = `${SLOT_NAMES[a.slot]} ${a.def.name}`, B = `${SLOT_NAMES[b.slot]} ${b.def.name}`;
      out.push({ a: a.slot, b: b.slot, kind, text: kind === 'collide' ? `${A} AND ${B} NEED THE SAME SPACE` : kind === 'fireA' ? `${B} BLOCKS THE LINE OF FIRE OF ${A}` : `${A} BLOCKS THE LINE OF FIRE OF ${B}` });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // MAIN MODEL
  // ---------------------------------------------------------------------------
  // rough price of one parts-list line at heavyweight scale (USD); these are estimates, not quotes
  function priceOf(p, cfg, lay) {
    if (p.usd !== undefined && p.id.startsWith('x_')) return p.usd;
    const kg = p.total, id = p.id;
    if (id.startsWith('pack_')) return lay.pack.wh * 1.1;
    if (id.startsWith('desc_') || /:esc\d/.test(id)) return 60 + kg * 420;
    if (id.startsWith('dmotor_') || /:motor\d/.test(id)) return 45 + kg * 170;
    if (id.startsWith('wheel_')) return 15 + kg * 60;
    if (id === 'armor_side') return kg * USD_PER_KG[faceOf(cfg, 'side').mat] + 120;
    if (id === 'armor_top') return kg * USD_PER_KG[faceOf(cfg, 'top').mat] + 60;
    if (id === 'frame') return 450 + kg * 22;
    if (id === 'ballast') return kg * 70;
    if (id === 'fasteners') return kg * 40;
    return { STRUCTURE: 30, ARMOR: 25, DRIVE: 120, ELECTRICAL: 260, WEAPON: 48 }[p.cat] * kg + (p.cat === 'WEAPON' ? 25 : 10) * p.qty;
  }

  // Smaller weight classes are shown as dynamically similar scale models of the heavyweight the maths runs on:
  // lengths x k, masses and energies x k^3, forces x k^2, voltage and current x k, times x k, rotor rpm / k, with
  // tip and ground speeds unchanged. Rather than thread units through every formula, the finished text is
  // rescaled here: every "number + unit" in a string is multiplied by the factor for that unit.
  const UNIT_POW = {
    'KG·M²': 5, 'KG/M³': 0, 'KG/M²': 1, 'KG·CM': 4, 'TONNE-F': 2, 'DEG/S': -1, '°/S': -1, 'G/S': 2, 'M/S': 0, 'N·M': 3, 'LBF': 2, 'MPH': 0, 'RPM': -1, 'MPA': 0, 'BAR': 0, 'PSI': 0,
    'KG': 3, 'LB': 3, 'KN': 2, 'KJ': 3, 'KW': 2, 'KV': -2, 'WH': 3, 'AH': 2, 'Ah': 2, 'MM': 1, 'IN': 1, 'FT': 1, 'A': 1, 'V': 1, 'W': 2, 'J': 3, 'L': 3, 'M': 1, 'S': 1, 'G': 3, 'N': 2,
  };
  const UNIT_ALT = Object.keys(UNIT_POW).sort((a, b) => b.length - a.length).map((x) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
  const SCALE_RE = new RegExp(
    '((?:\\d[\\d,]*(?:\\.\\d+)?\\s[×x]\\s)+\\d[\\d,]*(?:\\.\\d+)?)\\s(IN|MM)(?![\\w/²³])' + // 1,2: "34 × 28 × 6.7 IN"
    '|(?<![\\w.#-])(\\d+)S(?=\\d+P\\b|(?![\\w/]))' + // 3: cells in series, "12S", "12S2P"
    '|(?<![\\w.#-])(\\d+) AWG\\b' + // 4
    '|(?<![\\w.#-])(\\d[\\d,]*(?:\\.\\d+)?)(\\s?)(' + UNIT_ALT + ')(?![\\w/²³])(?! BEC)', 'g'); // 5,6,7
  function scaleText(str, k) {
    if (!str || k === 1 || typeof str !== 'string') return str;
    const num = (x) => parseFloat(x.replace(/,/g, ''));
    const out = (v) => { const a = Math.abs(v); if (a > 0 && a < 0.01) return v.toLocaleString('en-US', { maximumSignificantDigits: 2 }); const d = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : a >= 0.1 ? 3 : 4; return v.toLocaleString('en-US', { maximumFractionDigits: d }); };
    return str.replace(SCALE_RE, (m, list, lu, cells, awg, n, sp, unit) => {
      if (list) return list.split(/\s[×x]\s/).map((x) => out(num(x) * k)).join(' × ') + ' ' + lu;
      if (cells) return Math.max(1, Math.round(Number(cells) * k)) + 'S';
      if (awg) return Math.max(0, Math.min(30, Math.round(Number(awg) - 3 * Math.log2(k)))) + ' AWG';
      if (unit === 'S' && !sp) return m; // "3S" style tokens are handled above
      if ((unit === 'G' || unit === 'N' || unit === 'M' || unit === 'L' || unit === 'S' || unit === 'A' || unit === 'V' || unit === 'W' || unit === 'J') && !sp) return m;
      const pw = UNIT_POW[unit];
      return pw === 0 ? m : out(num(n) * Math.pow(k, pw)) + sp + unit;
    });
  }

  function compute(input, opt) {
    const cfg = normalize(input);
    const ch = chassisOf(cfg);
    const wheel = WHEELS[cfg.wheel];
    const bat = BATTERIES[cfg.battery];
    const mat = MATERIALS[cfg.armorMat];
    const dm = DRIVE_MOTORS[cfg.driveMotor];
    const dEsc = ESCS[cfg.driveEsc];
    const isDog = ch.shape === 'dog';
    const round = ch.shape === 'round';
    const active = SLOTS.filter((s) => cfg.slots[s]);
    const escList = [];
    active.forEach((s) => { for (let i = 0; i < escCountOf(cfg.slots[s]); i++) escList.push({ slot: s, i, esc: ESCS[cfg.slots[s].esc] }); });
    const lay = layoutFor(cfg, escList.length, opt);
    lay.placeWeaponEscs(escList.map((e) => e.esc.dims));
    const shellSlot = active.find((s) => cfg.slots[s].type === 'shell');
    if (shellSlot) applyShellMounts(lay, cfg, shellSlot);

    const parts = [];
    const add = (id, cat, name, spec, kg, qty, pos) => parts.push({ id, cat, name, spec, kg, qty, total: kg * qty, pos: pos || { x: 0, y: lay.cy, z: 0 } });

    // ---- battery / bus basics -------------------------------------------------
    const S = cfg.cells, P = cfg.parallel;
    const isolated = lay.isolated;
    const Pw = isolated ? Math.max(1, P - 1) : P;
    const Pd = isolated ? 1 : P;
    const vNom = S * bat.vCell;
    const rPack = (p) => (S * bat.rCellAh) / bat.ah / p + 0.0015;
    const iPackMax = (p) => p * bat.ah * bat.c;
    const packKg = S * bat.ah * bat.kgPerAhCell * 1.06;

    // ---- structure -------------------------------------------------------------
    let frameKg;
    if (ch.shape === 'round') frameKg = Math.PI * ch.R * ch.R * ch.baseT * RHO_AL + 6 * 0.5 + 4.0;
    else if (ch.shape === 'tube') frameKg = (4 * (ch.L + ch.W) + 8 * ch.H + 4.0) * ch.tubeKgPerM + ch.L * ch.W * ch.baseT * RHO_AL;
    else {
      const bw = 2 * lay.bodyHalfW;
      frameKg = 2 * (ch.L + bw) * ch.H * ch.wallT * RHO_AL * ch.pocket + ch.L * bw * ch.baseT * RHO_AL + 2 * bw * (ch.H - 0.02) * ch.wallT * RHO_AL * ch.pocket;
    }
    add('frame', 'STRUCTURE', ch.name + ' FRAME', ch.shape === 'tube' ? '4130 TUBE 32 x 2.1 MM' : ch.shape === 'round' ? '6061 BASE + POSTS' : `6061-T6 · ${(ch.wallT * 1000).toFixed(1)} MM WALL`, frameKg, 1);
    if (isDog) add('legs', 'STRUCTURE', 'LEG ASSEMBLY', '7075 LINKS · 2-DOF · RUBBER FEET', 2.9, ch.legs, { x: 0, y: lay.bottomY * 0.5, z: 0 });

    const tSide = lay.tSide, tTop = lay.tTop;
    // perimeter split into front / rear / two sides so each face can carry its own plate
    const fF = faceOf(cfg, 'front'), fS = faceOf(cfg, 'side'), fR = faceOf(cfg, 'rear'), fT = faceOf(cfg, 'top');
    let aFront, aRear, aSides, topArea;
    if (ch.shape === 'round') { aFront = aRear = 0; aSides = 2 * Math.PI * ch.R * (ch.H + 0.02) * 0.35; topArea = Math.PI * ch.R * ch.R; }
    else {
      const bw = 2 * lay.bodyHalfW, hh = ch.H + 0.02, kx = ch.shape === 'hex' ? 0.9 : 1;
      aFront = bw * hh * kx * lay.taper; aRear = bw * hh * kx; aSides = 2 * ch.L * hh * kx;
      topArea = ch.L * bw * (ch.shape === 'hex' ? 0.86 : ch.shape === 'delta' ? 0.65 : 1) + (ch.shape === 'wedge' ? bw * 0.24 : 0) - 2 * lay.notch.half * (lay.notch.f + lay.notch.r);
    }
    const sideKg = aFront * (fF.t / 1000) * MATERIALS[fF.mat].rho + aRear * (fR.t / 1000) * MATERIALS[fR.mat].rho + aSides * (fS.t / 1000) * MATERIALS[fS.mat].rho;
    const short = (m) => MATERIALS[m].name.split(' ').slice(-1)[0];
    const sideSpec = cfg.armorFaces ? `FRONT ${fF.t.toFixed(1)} MM ${short(fF.mat)} · SIDES ${fS.t.toFixed(1)} MM ${short(fS.mat)} · REAR ${fR.t.toFixed(1)} MM ${short(fR.mat)}` : `${mat.name} · ${cfg.armorT.toFixed(1)} MM`;
    add('armor_side', 'ARMOR', ch.shape === 'round' ? 'SKIRT ARMOR' : 'PERIMETER ARMOR', sideSpec, sideKg, 1);
    add('armor_top', 'ARMOR', 'TOP PLATE', `${MATERIALS[fT.mat].name} · ${fT.t.toFixed(1)} MM`, topArea * tTop * MATERIALS[fT.mat].rho, 1, { x: 0, y: lay.topY, z: 0 });
    if (cfg.ballastKg > 0) add('ballast', 'STRUCTURE', 'BALLAST', `TUNGSTEN · ${cfg.ballastZ >= 0 ? 'FRONT' : 'REAR'} BIASED`, cfg.ballastKg, 1, { x: 0, y: lay.floorY + 0.02, z: cfg.ballastZ * (round ? lay.Rb : ch.L / 2) * 0.8 });

    // ---- drive ------------------------------------------------------------------
    const nDrive = lay.driveMotors.length;
    lay.wheels.forEach((w, i) => add('wheel_' + i, 'DRIVE', 'DRIVE WHEEL', wheel.name, wheel.kg, 1, w));
    lay.driveMotors.forEach((mm, i) => {
      add('dmotor_' + i, 'DRIVE', isDog ? 'LEG DRIVE MOTOR' : 'DRIVE MOTOR', `${dm.name} · ${dm.kv} KV`, dm.kg, 1, mm);
      add('gearbox_' + i, 'DRIVE', cfg.hub ? 'HUB GEAR STAGE' : cfg.twoSpeed ? 'TWO-SPEED GEARBOX' : 'PLANETARY GEARBOX', cfg.twoSpeed ? `${cfg.driveRatio.toFixed(1)}:1 HIGH · ${(cfg.driveRatio * 1.8).toFixed(1)}:1 LOW` : `${cfg.driveRatio.toFixed(1)}:1`, (cfg.hub ? 0.5 : 0.9) + (cfg.twoSpeed ? 0.7 : 0), 1, { x: mm.x + mm.side * 0.07, y: mm.y, z: mm.z });
    });
    const nW = lay.nW;
    if (nW >= 4 && !cfg.hub) add('chains', 'DRIVE', 'DRIVE CHAIN SET', '#35 ROLLER CHAIN', 0.3, nW, { x: 0, y: lay.cy, z: 0 });
    if (ch.tracks) add('tracks', 'DRIVE', 'RUBBER TRACKS', 'KEVLAR-CORD BELT · MOULDED LUGS', 3.2, 2, { x: 0, y: lay.wR, z: 0 });
    if (lay.caster) add('caster', 'DRIVE', 'FRONT CASTER', 'HARDENED BALL TRANSFER', 0.8, 1, lay.caster);
    if (cfg.magnets > 0) add('magnets', 'DRIVE', 'FLOOR MAGNETS', `N52 POT MAGNETS · ${cfg.magnets * 350} N DOWNFORCE`, 0.45, cfg.magnets * 2, { x: 0, y: lay.bottomY, z: 0 });
    if (cfg.guards && lay.wheels.length) add('guards', 'ARMOR', 'WHEEL GUARDS', 'CLOSED ARCHES · AR500 COVERS', 0.6, lay.wheels.length, { x: 0, y: lay.wR, z: 0 });
    if (cfg.susp && lay.wheels.length) add('susp', 'DRIVE', 'SUSPENSION', 'TRAILING ARMS · ELASTOMER SPRINGS', 0.35, lay.wheels.length, { x: 0, y: lay.wR, z: 0 });
    Object.keys(EXTRAS).filter((k) => cfg.extras[k]).forEach((k, i) => { const e = EXTRAS[k]; parts.push({ id: 'x_' + k, cat: 'ELECTRICAL', name: e.name, spec: e.spec, kg: e.kg, qty: 1, total: e.kg, pos: lay.extraPos(i), usd: e.usd }); });
    lay.driveEscs.forEach((e, i) => add('desc_' + i, 'ELECTRICAL', 'DRIVE ESC', dEsc.name, dEsc.kg, 1, e));
    lay.packs.forEach((pk, i) => add('pack_' + i, 'ELECTRICAL', 'BATTERY PACK', `${bat.name} · ${S}S · ${lay.pack.wh.toFixed(0)} WH`, packKg, 1, pk));

    // ---- modules ------------------------------------------------------------------
    const env = { S, vNom, rPack: rPack(Pw), iPackMax: iPackMax(Pw) };
    const mods = {};
    const checks = [];
    let iWeaponPeak = 0, iWeaponHold = 0, whWeapons = 0;
    const loadById = {};
    let escIdx = 0;
    // the shell is computed last: whatever rides on it adds to its inertia, reach and balance
    const order = active.filter((s) => s !== shellSlot).concat(shellSlot ? [shellSlot] : []);
    for (const slot of order) {
      let menv = env;
      if (slot === shellSlot) {
        const rd = { I: 0, ub: [0, 0], tip: 0, n: lay.shell.riders.length, powered: false, mast: lay.shell.mastDeck !== null };
        for (const r of lay.shell.riders) {
          for (const p of mods[r].parts) { rd.I += p.total * (p.pos.x * p.pos.x + p.pos.z * p.pos.z); rd.ub[0] += p.total * p.pos.x; rd.ub[1] += p.total * p.pos.z; rd.tip = Math.max(rd.tip, Math.hypot(p.pos.x, p.pos.z) + 0.06); }
          if (mods[r].iPeak > 0) rd.powered = true;
        }
        menv = { ...env, ride: rd };
      }
      const o = moduleCalc(slot, cfg.slots[slot], lay, menv);
      mods[slot] = o;
      parts.push(...o.parts);
      o.escPos = [];
      for (let i = 0; i < o.escs; i++) {
        const pos = lay.weaponEscs[escIdx++];
        o.escPos.push(pos);
        const e = ESCS[cfg.slots[slot].esc];
        parts.push({ id: `${slot}:esc${i}`, cat: 'ELECTRICAL', name: 'WEAPON ESC', spec: `${e.name} · ${SLOT_NAMES[slot]}`, kg: e.kg, qty: 1, total: e.kg, pos, slot });
        loadById[`${slot}:esc${i}`] = o.loads.esc || 0;
        loadById[`${slot}:motor${i}`] = o.loads.motor || 0;
      }
      iWeaponPeak += o.iPeak; iWeaponHold += o.iHold; whWeapons += o.wh;
      checks.push(...o.checks);
      o.env = envelope(o);
    }
    const conflicts = findConflicts(mods, active);
    conflicts.forEach((c, i) => checks.push({ id: 'clash' + i, label: `${SLOT_NAMES[c.a]} × ${SLOT_NAMES[c.b]} · INTERFERENCE`, status: 'fail', detail: c.text }));

    const ktD = 60 / (2 * Math.PI * dm.kv);
    const iLimDrive = Math.min(dm.iMax, dEsc.cont * ESC_BURST, iPackMax(Pd) / nDrive);

    // ---- small electrical -----------------------------------------------------------
    const iBusGuess = iWeaponPeak + nDrive * iLimDrive * 0.6;
    const gauge = WIRE_GAUGES.find((gg) => iBusGuess <= gg.burstA) || WIRE_GAUGES[WIRE_GAUGES.length - 1];
    lay.switches.forEach((sw, i) => add('switch_' + i, 'ELECTRICAL', 'MASTER SWITCH', 'REMOVABLE-LINK DISCONNECT', 0.25, 1, sw));
    add('fuse', 'ELECTRICAL', 'MAIN FUSE', 'ANL BOLT-DOWN', 0.1, 1, lay.fuse);
    lay.buses.forEach((bb, i) => add('bus_' + i, 'ELECTRICAL', 'COPPER BUSBARS', 'POS + NEG DISTRIBUTION', 0.35, 1, bb));
    add('rx', 'ELECTRICAL', 'RECEIVER + BEC + LED', '2.4 GHZ · FAILSAFE · 5 V BEC', 0.09, 1, lay.receiver);
    const wireLen = 3.0 + 0.7 * escList.length + 0.35 * active.length + (isolated ? 0.8 : 0) + (isDog ? 1.0 : 0);
    add('wiring', 'ELECTRICAL', 'POWER + SIGNAL HARNESS', `${gauge.awg} AWG SILICONE · ${wireLen.toFixed(1)} M`, wireLen * gauge.kgPerM + 0.25, 1, { x: 0, y: lay.floorY + 0.02, z: -0.05 });
    const pre = parts.reduce((a, p) => a + p.total, 0);
    add('fasteners', 'STRUCTURE', 'FASTENERS + MOUNTS', 'GRADE 12.9 · SHOCK ISOLATORS', pre * 0.025, 1);

    // ---- mass + CG ---------------------------------------------------------------------
    let mass = 0, mx = 0, my = 0, mz = 0;
    const byCat = {};
    for (const p of parts) {
      mass += p.total; mx += p.total * p.pos.x; my += p.total * p.pos.y; mz += p.total * p.pos.z;
      byCat[p.cat] = (byCat[p.cat] || 0) + p.total;
    }
    const cg = { x: mx / mass, y: my / mass, z: mz / mass };
    const massLb = mass * KG_TO_LB;
    if (!opt && !isDog && lay.nW === 2 && ch.shape !== 'round') return compute(input, { axleZ: cg.z * 0.85 });

    // ---- drive ---------------------------------------------------------------------------
    const outRpm = (dm.kv * vNom) / cfg.driveRatio;
    const mu = (isDog ? 0.8 : wheel.mu * TYRES[cfg.tyre].mu) * (ch.tracks ? 1.15 : 1) * (cfg.susp ? 1.04 : 1);
    const rEff = isDog ? 0.28 / (2 * Math.PI) : wheel.d / 2; // a leg's crank turn advances one stride
    const topSpeed = (outRpm / 60) * 2 * Math.PI * rEff * 0.85;
    let drivenFrac = 1;
    if (!isDog && lay.nW === 2) {
      const za = lay.wheelbase.zFront;
      const skid = cg.z >= za ? Math.max(lay.skidZ, cg.z + 0.05) : lay.footprint.zRear + 0.02;
      drivenFrac = clamp(1 - (cg.z - za) / (skid - za), 0.2, 1);
    }
    const downforce = cfg.magnets * 350; // floor magnets add grip without adding (much) weight
    const pushTraction = mu * (mass * G * drivenFrac + downforce);
    const lowGear = cfg.twoSpeed ? 1.8 : 1; // pushing is done in low gear, top speed in high
    const torqueEach = ktD * iLimDrive * cfg.driveRatio * lowGear * 0.88;
    const pushMotor = (nDrive * torqueEach) / rEff;
    const iTraction = ((pushTraction / nDrive) * rEff) / (cfg.driveRatio * lowGear * 0.88 * ktD);
    const iDrivePeak = nDrive * Math.min(iLimDrive, iTraction);
    const drive = { topSpeed, outRpm, drivenFrac, pushTraction, pushMotor, push: Math.min(pushTraction, pushMotor), iPeak: iDrivePeak, iLim: iLimDrive, stallRisk: pushMotor < pushTraction, accel: Math.min(pushTraction, pushMotor) / mass, legs: isDog, strafe: !!wheel.strafe && !isDog && !ch.tracks, downforce, mu };
    const driveWh = (vNom * iDrivePeak * 0.3 * LIMITS.matchSeconds) / 3600;

    // ---- electrical ----------------------------------------------------------------------
    const busOf = (packs, iPeak) => { const r = rPack(packs), sag = iPeak * r * (cfg.extras.caps ? 0.8 : 1); return { packs, iPeak, iMax: iPackMax(packs), sag, vMin: vNom - sag, vMinCell: (vNom - sag) / S, r }; };
    const weaponBus = busOf(Pw, isolated ? iWeaponPeak : iWeaponPeak + iDrivePeak);
    const driveBus = busOf(Pd, isolated ? iDrivePeak : iWeaponPeak + iDrivePeak);
    const whTotal = lay.pack.wh * P;
    const whNeeded = whWeapons + driveWh;
    const fuseA = FUSE_SIZES.find((x) => x >= weaponBus.iPeak * 0.75) || FUSE_SIZES[FUSE_SIZES.length - 1];
    loadById.wiring = weaponBus.iPeak / gauge.burstA;
    const packLoad = Math.max(weaponBus.iPeak / weaponBus.iMax, driveBus.iPeak / driveBus.iMax);
    lay.packs.forEach((_, i) => { loadById['pack_' + i] = packLoad; });
    lay.driveEscs.forEach((_, i) => { loadById['desc_' + i] = iDrivePeak / nDrive / (dEsc.cont * ESC_BURST); });
    lay.driveMotors.forEach((_, i) => { loadById['dmotor_' + i] = iDrivePeak / nDrive / dm.iMax; });
    ['fuse', 'bus_0', 'bus_1', 'switch_0', 'switch_1'].forEach((id) => { loadById[id] = loadById.wiring; });
    const electrical = { vNom, S, P, isolated, weaponBus, driveBus, whTotal, whUsable: whTotal * 0.8, whNeeded, gaugeAwg: gauge.awg, wireD: gauge.d, fuseA, iWeaponPeak, iWeaponHold, packKg, loadById, nWeaponEsc: escList.length };

    // ---- dynamics ----------------------------------------------------------------------------
    const dyn = {};
    const track = lay.wheels.length ? 2 * Math.abs(lay.wheels[0].x) : 2 * (lay.W / 2 + 0.06);
    const spinMods = active.map((s) => mods[s]).filter((o) => o.spin);
    const Lx = spinMods.filter((o) => o.axis === 'x').reduce((a, o) => a + o.angMom, 0);
    if (Lx > 0) dyn.gyroTurnLimit = (mass * G * (track / 2)) / Lx;
    const react = Math.max(0, ...spinMods.map((o) => o.reaction || 0));
    if (react > 0) { dyn.reactionTorque = react; dyn.yawGrip = mu * mass * G * 0.35 * Math.hypot(ch.L, ch.W) * 0.5; }
    const primary = spinMods.slice().sort((a, b) => b.spin.ke - a.spin.ke)[0];
    if (primary) { const rps = primary.spin.wFinal / (2 * Math.PI); dyn.bite = rps > 0 ? topSpeed / (rps * primary.md.teeth) : 0; dyn.biteSlot = primary.slot; }
    dyn.keTotal = spinMods.reduce((a, o) => a + o.spin.ke, 0);
    for (const sl of active) {
      const o = mods[sl];
      if (!o.melty) continue;
      // the whole bot is the rotor: the two drive sides run in opposite directions and the controller pulses them to translate
      let Iz = 0, reach = 0;
      for (const p of parts) { const dx = p.pos.x - cg.x, dz = p.pos.z - cg.z; Iz += p.total * (dx * dx + dz * dz + 0.004); reach = Math.max(reach, Math.hypot(p.pos.x, p.pos.z)); }
      reach = Math.max(reach + 0.05, round ? lay.Rb : Math.hypot(ch.L / 2, ch.W / 2));
      const arm = track / 2, eff = isDog ? 0 : lay.nW === 2 ? 1 : 0.55;
      const w = (topSpeed / arm) * eff, tq = drive.push * arm * eff;
      const t90 = w > 0 ? ((Iz * w) / Math.max(tq, 1)) * 1.3 : null;
      const ke = 0.5 * Iz * w * w, tipMph = w * reach * MS_TO_MPH;
      o.meltySpin = { w, rpm: (w * 60) / (2 * Math.PI), ke, t90, tip: w * reach, Iz, reach };
      const tau = Math.max(0.05, (t90 || 1) / 2.3), tEnd = Math.min(40, (t90 || 1) * 1.6 + 1), curve = [];
      for (let tt = 0; tt <= tEnd + 1e-9; tt += 0.1) { const e = Math.exp(-tt / tau); curve.push({ t: tt, w: w * (1 - e), i: drive.iPeak * (0.3 + 0.7 * e) }); }
      o.spin = { wFinal: w, rpm: o.meltySpin.rpm, tip: w * reach, ke, t90, tEnd, curve, iPeak: drive.iPeak, iHold: drive.iPeak * 0.3, whole: true };
      Object.assign(o.geo, { tipR: reach, inertia: Iz, mass });
      o.hero = { v: f(ke / 1000, 1), u: 'KJ', l: 'WHOLE-BOT KINETIC ENERGY' };
      o.rows = [
        ['BODY SPIN', `${f(o.meltySpin.rpm)} RPM`],
        ['TIP SPEED', `${f(tipMph)} MPH<small>/ ${LIMITS.tipMph}</small>`, tipMph > LIMITS.tipMph],
        ['SPIN-UP', t90 === null ? 'NEVER' : `${t90.toFixed(1)} S`, t90 === null],
        ['TRAVEL WHILE SPINNING', `${f(topSpeed * 0.25 * MS_TO_MPH, 1)} MPH`],
        ['REACH', `${f(reach * 2 * M_TO_IN, 1)} IN SWEPT`],
      ];
      const lb = `${SLOT_NAMES[sl]} · `;
      checks.push({ id: `${sl}:mtip`, label: lb + 'TIP SPEED', status: tipMph <= LIMITS.tipMph ? 'pass' : 'fail', detail: `${f(tipMph)} / ${LIMITS.tipMph} MPH` });
      checks.push({ id: `${sl}:mdrive`, label: lb + 'SPIN DRIVE', status: isDog ? 'fail' : lay.nW === 2 ? 'pass' : 'warn', detail: isDog ? 'LEGS CANNOT SPIN THE BODY' : lay.nW === 2 ? 'TWO WHEELS · SPINS FREELY ABOUT THE CENTRE' : 'EXTRA WHEELS SCRUB SIDEWAYS · SPINS SLOWER' });
      const off = Math.hypot(cg.x, cg.z);
      checks.push({ id: `${sl}:mbal`, label: lb + 'SPIN BALANCE', status: off < 0.02 ? 'pass' : off < 0.06 ? 'warn' : 'fail', detail: off < 0.02 ? 'CG ON THE SPIN AXIS' : `CG ${f(off * 1000)} MM OFF THE SPIN AXIS · WOBBLES AT SPEED` });
      dyn.keTotal += ke; dyn.melty = { w, ke };
    }

    // ---- packaging -----------------------------------------------------------------------------
    const cyl = (d, l) => (Math.PI * d * d * l) / 4;
    let compVol = lay.pack.vol * 1.15 * P + nDrive * (cyl(dm.d, dm.l) + cyl(0.06, 0.07)) + 2 * dEsc.dims[0] * dEsc.dims[1] * dEsc.dims[2] + 0.0006;
    escList.forEach((e) => { compVol += e.esc.dims[0] * e.esc.dims[1] * e.esc.dims[2]; });
    const packaging = { compVol, bayVolume: lay.bayVolume, fill: compVol / (lay.bayVolume * 0.45) };
    const packRowW = P * lay.pack.w + (P - 1) * 0.012;

    // ---- armor + inversion -------------------------------------------------------------------------
    const armor = { material: mat.name, tSide: cfg.armorT, tTop: tTop * 1000, arealKgM2: mat.rho * tSide, strengthIdx: (mat.yieldMPa * cfg.armorT * cfg.armorT) / 1000 };
    let topMost = lay.deckY;
    active.forEach((s) => { topMost = Math.max(topMost, mods[s].topMost); });
    const wheelTop = isDog ? 0 : wheel.d;
    const invertible = !isDog && wheelTop + 0.004 >= topMost;
    const selfRights = active.some((s) => mods[s].selfRight);
    const invertRest = invertible ? wheelTop : topMost;

    // ---- global checks -----------------------------------------------------------------------------
    const chk = (id, label, status, detail) => checks.push({ id, label, status, detail });
    checks.unshift({ id: 'weight', label: 'WEIGHT LIMIT', status: massLb <= LIMITS.weightLb ? (massLb > LIMITS.weightLb - 2 ? 'warn' : 'pass') : 'fail', detail: massLb <= LIMITS.weightLb ? `${(LIMITS.weightLb - massLb).toFixed(1)} LB UNDER THE LIMIT` : `${(massLb - LIMITS.weightLb).toFixed(1)} LB OVER` });
    chk('desc_v', 'DRIVE ESC VOLTAGE', dEsc.maxS >= S ? 'pass' : 'fail', `${S}S PACK ON ${dEsc.maxS}S ESC`);
    const worstBus = weaponBus.iPeak / weaponBus.iMax >= driveBus.iPeak / driveBus.iMax ? weaponBus : driveBus;
    chk('crate', 'BATTERY C-RATE', worstBus.iPeak <= worstBus.iMax ? (worstBus.iPeak > worstBus.iMax * 0.85 ? 'warn' : 'pass') : 'fail', `${f(worstBus.iPeak)} A PEAK / ${f(worstBus.iMax)} A RATED`);
    const vCellMin = Math.min(weaponBus.vMinCell, driveBus.vMinCell);
    chk('sag', 'VOLTAGE SAG', vCellMin >= bat.cutoff + 0.2 ? 'pass' : vCellMin >= bat.cutoff ? 'warn' : 'fail', `${vCellMin.toFixed(2)} V/CELL MIN · CUTOFF ${bat.cutoff.toFixed(1)}`);
    if (isolated) chk('bus', 'BUS ISOLATION', 'pass', 'DRIVE + WEAPONS ON SEPARATE PACKS');
    else if (iWeaponPeak > 20) chk('bus', 'BUS ISOLATION', 'warn', 'SHARED BUS: WEAPON SAG REACHES DRIVE');
    chk('energy', 'MATCH ENERGY', whNeeded <= electrical.whUsable ? (whNeeded > electrical.whUsable * 0.8 ? 'warn' : 'pass') : 'fail', `${f(whNeeded)} WH NEEDED / ${f(electrical.whUsable)} WH USABLE`);
    chk('pack', 'BAY PACKAGING', packaging.fill <= 0.85 ? 'pass' : packaging.fill <= 1 ? 'warn' : 'fail', `${(packaging.fill * 100).toFixed(0)}% OF USABLE BAY`);
    if (ch.shape !== 'round') chk('packw', 'PACK ROW WIDTH', packRowW <= 2 * lay.bayHalfW ? 'pass' : 'fail', packRowW <= 2 * lay.bayHalfW ? `${f(packRowW * 1000)} MM IN A ${f(2 * lay.bayHalfW * 1000)} MM BAY` : `${f(packRowW * 1000)} MM ROW · BAY IS ${f(2 * lay.bayHalfW * 1000)} MM`);
    const headroom = lay.topY - 0.004 - lay.stackTop;
    chk('stack', 'STACK HEIGHT', headroom >= 0.01 ? 'pass' : headroom >= 0 ? 'warn' : 'fail', headroom >= 0 ? `${(headroom * 1000).toFixed(0)} MM UNDER TOP PLATE` : `${(-headroom * 1000).toFixed(0)} MM THROUGH TOP PLATE`);
    chk('drive', 'DRIVE TORQUE', drive.stallRisk ? 'warn' : 'pass', drive.stallRisk ? 'MOTORS STALL BEFORE GRIP BREAKS' : isDog ? 'TRACTION-LIMITED (FEET SLIP FIRST)' : 'TRACTION-LIMITED (WHEELS SLIP FIRST)');
    if (dyn.gyroTurnLimit !== undefined) { const d = (dyn.gyroTurnLimit * 180) / Math.PI; chk('gyro', 'GYRO TURN LIMIT', d >= 90 ? 'pass' : d >= 40 ? 'warn' : 'fail', `WHEEL LIFTS ABOVE ${f(d)} DEG/S`); }
    if (dyn.reactionTorque !== undefined) chk('react', 'SPIN-UP REACTION', dyn.reactionTorque <= dyn.yawGrip ? 'pass' : 'warn', `${f(dyn.reactionTorque)} N·M VS ${f(dyn.yawGrip)} N·M GRIP`);
    if (!isDog && lay.nW === 2) chk('cg', 'WEIGHT ON DRIVE', drivenFrac >= 0.6 ? 'pass' : drivenFrac >= 0.4 ? 'warn' : 'fail', `${(drivenFrac * 100).toFixed(0)}% ON DRIVE WHEELS`);
    else {
      const fz = (cg.z - lay.wheelbase.zRear) / Math.max(0.01, lay.wheelbase.zFront - lay.wheelbase.zRear);
      chk('cg', isDog ? 'CG OVER FEET' : 'CG IN WHEELBASE', fz >= 0.15 && fz <= 0.85 ? 'pass' : fz >= 0 && fz <= 1 ? 'warn' : 'fail', fz >= 0 && fz <= 1 ? `${(fz * 100).toFixed(0)}% FRONT LOAD` : 'CG OUTSIDE THE SUPPORT BASE · TIPS OVER');
    }
    chk('invert', 'IF FLIPPED', invertible || selfRights ? 'pass' : 'info', invertible ? 'DRIVES INVERTED' : selfRights ? 'SELF-RIGHTING ARM RECOVERS' : isDog ? 'WALKER CANNOT RECOVER' : `BODY ${((topMost - wheelTop) * 1000).toFixed(0)} MM TALLER THAN WHEELS`);
    if (!active.some((s) => mods[s].kind !== 'passive' && mods[s].kind !== 'srimech')) chk('noweapon', 'ACTIVE WEAPON', 'warn', 'NO ACTIVE WEAPON INSTALLED');

    if (cfg.extras.fans) for (const k of Object.keys(loadById)) if (/esc|desc_|motor/.test(k)) loadById[k] *= 0.85;
    if (cfg.magnets) chk('mag', 'FLOOR MAGNETS', 'info', `${f(downforce)} N EXTRA GRIP · STEEL FLOORS ONLY`);
    if (drive.strafe) chk('strafe', 'STRAFING', 'info', 'WHEELS ALLOW SIDEWAYS TRAVEL · LESS PUSH');
    if (cfg.cluster) chk('cluster', 'CLUSTER PAIR', 'info', 'TWO IDENTICAL BOTS SHARE THE WEIGHT LIMIT');
    const bigKe = dyn.keTotal > 20000;
    chk('shock', 'SHOCK ISOLATION', cfg.extras.shock ? 'pass' : bigKe ? 'warn' : 'info', cfg.extras.shock ? 'ELECTRONICS ON ISOLATORS' : bigKe ? 'HARD-MOUNTED ELECTRONICS NEXT TO A BIG SPINNER' : 'ELECTRONICS HARD-MOUNTED');
    chk('batbox', 'BATTERY PROTECTION', cfg.extras.batbox ? 'pass' : 'info', cfg.extras.batbox ? 'PACKS IN AN ARMOURED BOX' : 'PACKS RELY ON THE HULL ARMOUR');
    if (dyn.keTotal > 0) chk('brake', 'SPIN-DOWN', cfg.extras.brake ? 'pass' : 'info', cfg.extras.brake ? 'WEAPON BRAKE STOPS THE ROTOR IN SECONDS' : 'ROTOR COASTS DOWN · NO BRAKE FITTED');
    if (cfg.extras.gyro) chk('gyrox', 'DRIVE CONTROL', 'pass', 'GYRO HOLDS HEADING');
    if (cfg.extras.rx2) chk('rx2', 'RADIO LINK', 'pass', 'REDUNDANT RECEIVER');

    // ---- weight class + cost ----------------------------------------------------------------------
    const limitLb = CLASSES[cfg.cls].lb / (cfg.cluster ? 2 : 1);
    const k = Math.cbrt(limitLb / LIMITS.weightLb);
    const u = { k, cls: cfg.cls, className: CLASSES[cfg.cls].name, limitLb, count: cfg.cluster ? 2 : 1 };
    let cost = 0;
    for (const p of parts) { p.usd = Math.round(priceOf(p, cfg, lay) * Math.pow(k, 1.6) * 100) / 100; cost += p.usd; }
    cost *= u.count;

    const fails = checks.filter((c) => c.status === 'fail').length;
    const warns = checks.filter((c) => c.status === 'warn').length;
    return { cfg, chassis: ch, layout: lay, parts, mass, massLb, byCat, cg, track, drive, electrical, mods, active, conflicts, dyn, u, cost, packaging, armor, invertible, selfRights, invertRest, topMost, checks, fails, warns, legal: fails === 0, isDog };
  }

  function bomCsv(build) {
    const m = Math.pow(build.u.k, 3), k = build.u.k;
    const rows = [['CATEGORY', 'PART', 'SPEC', 'QTY', 'UNIT_KG', 'TOTAL_KG', 'TOTAL_LB', 'EST_USD']];
    for (const p of build.parts) rows.push([p.cat, scaleText(p.name, k), scaleText(p.spec, k), p.qty, (p.kg * m).toFixed(4), (p.total * m).toFixed(4), (p.total * m * KG_TO_LB).toFixed(3), p.usd.toFixed(2)]);
    rows.push(['', 'TOTAL (PER BOT)', build.u.className, '', '', (build.mass * m).toFixed(4), (build.massLb * m).toFixed(3), (build.cost / build.u.count).toFixed(2)]);
    return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  return {
    G, KG_TO_LB, MS_TO_MPH, M_TO_IN, N_TO_LBF, LIMITS, ESC_BURST, SLOTS, SLOT_NAMES,
    CLASSES, TYRES, EXTRAS, FACES, GAS, MATERIALS, CHASSIS, MODULES, MODULE_CATS, MOTORIZED, PRESSURIZED, WEAPON_MOTORS, DRIVE_MOTORS, ESCS, BATTERIES, CELL_OPTIONS, WHEELS, TRANSMISSIONS, GROUND, FINISHES,
    DEFAULT_CFG, DEFAULT_MOD, PRESETS, normalize, normalizeMod, compute, bomCsv, toBot, scaleText, chassisOf, faceOf,
  };
});
