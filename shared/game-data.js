/* =========================================================================
   TIERRAS DE AETHEL — Compartición de datos
   El mismo código se ejecuta en el navegador (cliente) y en Node (servidor).
   Todo el contenido es determinista a partir de la semilla del mundo: cliente
   y servidor generan el mismo mapa, los mismos monstruos y los mismos objetos
   sin enviarse nada. Ninguna tirada de azar en el cliente decide nada: solo el
   servidor mueve la verdad y el cliente interpola.
   ========================================================================= */
(function (root) {
'use strict';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Dispersión determinista por coordenadas: mismo valor en cliente y servidor */
function hash2(x, y, salt) {
  let h = (x * 374761393 + y * 668265263 + (salt || 0) * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const rngFor = function (seed) { return mulberry32(seed); };

const TILE = 32;
const MAP_W = 160;
const MAP_H = 160;
const TICK_MS = 100;

const TERRAIN = {
  deep:      { name: 'Aguas profundas', walk: false, color: '#12305c' },
  water:     { name: 'Agua',            walk: false, color: '#1b4a80' },
  sand:      { name: 'Arena',           walk: true,  color: '#c9b06a' },
  grass:     { name: 'Pradera',         walk: true,  color: '#3f7a3a' },
  darkgrass: { name: 'Bosque',          walk: true,  color: '#2c5c32' },
  rock:      { name: 'Roca',            walk: true,  color: '#5c5a63' },
  snow:      { name: 'Nieve',           walk: true,  color: '#cfd8e3' },
  lava:      { name: 'Lava',            walk: false, color: '#7a2418' },
  road:      { name: 'Camino',          walk: true,  color: '#8a7a58' },
  floor:     { name: 'Suelo',           walk: true,  color: '#4a4038' },
  wall:      { name: 'Muro',            walk: false, color: '#2b2630' }
};

const BIOMES = {
  pradera: { id: 'pradera', name: 'Praderas de Robledal', tint: '#3f7a3a', terrain: 'grass',
    enemies: ['lobo_joven', 'jabali', 'bandido'], weights: [40, 34, 26],
    nodes: { arbol: 0.06, hierba: 0.05, piedra: 0.01 }, level: [1, 4] },
  bosque: { id: 'bosque', name: 'Bosque Umbrío', tint: '#2c5c32', terrain: 'darkgrass',
    enemies: ['arania', 'lobo_negro', 'bandido', 'ent'], weights: [34, 30, 22, 14],
    nodes: { arbol: 0.18, hierba: 0.06, piedra: 0.01 }, level: [4, 9] },
  ruinas: { id: 'ruinas', name: 'Ruinas de Qarim', tint: '#5c5a63', terrain: 'rock',
    enemies: ['esqueleto', 'golem', 'mago_rencoroso', 'bandido'], weights: [34, 26, 20, 20],
    nodes: { arbol: 0.01, hierba: 0.01, piedra: 0.12 }, level: [8, 14] },
  ceniza: { id: 'ceniza', name: 'Picos de Ceniza', tint: '#6b3a30', terrain: 'rock',
    enemies: ['draconido', 'troll', 'golem', 'espectro'], weights: [30, 26, 22, 22],
    nodes: { arbol: 0, hierba: 0, piedra: 0.16 }, level: [13, 20] },
  nieve: { id: 'nieve', name: 'Altiplanicie Helada', tint: '#cfd8e3', terrain: 'snow',
    enemies: ['espectro', 'lobo_negro', 'troll'], weights: [44, 30, 26],
    nodes: { arbol: 0.03, hierba: 0, piedra: 0.06 }, level: [16, 24] }
};

const MONSTERS = {
  lobo_joven:     { name: 'Lobo joven',          hp: 38,   atk: 9,  def: 2,  spd: 74, r: 11, aggro: 190, xp: 16,   gold: 9,    drops: [['cuero', 0.35], ['colmillo', 0.3]],    color: '#8d8d9a', art: 'lobo' },
  jabali:         { name: 'Jabalí',              hp: 52,   atk: 11, def: 4,  spd: 62, r: 13, aggro: 165, xp: 20,   gold: 11,   drops: [['cuero', 0.45], ['carne', 0.4]],      color: '#8a6a52', art: 'jabali' },
  bandido:        { name: 'Bandido',             hp: 60,   atk: 13, def: 5,  spd: 68, r: 12, aggro: 220, xp: 26,   gold: 28,   drops: [['cuero', 0.3], ['moneda_antigua', 0.15]], color: '#b5654f', art: 'humano' },
  arania:         { name: 'Araña sombría',       hp: 56,   atk: 15, def: 3,  spd: 80, r: 11, aggro: 200, xp: 30,   gold: 18,   drops: [['seda', 0.4], ['colmillo', 0.2]],     color: '#7b4f8f', art: 'arania' },
  lobo_negro:     { name: 'Lobo negro',          hp: 88,   atk: 20, def: 7,  spd: 86, r: 13, aggro: 230, xp: 46,   gold: 26,   drops: [['cuero', 0.4], ['colmillo', 0.35]],   color: '#4a4a58', art: 'lobo' },
  ent:            { name: 'Ent corrompido',      hp: 150,  atk: 22, def: 14, spd: 42, r: 18, aggro: 175, xp: 70,   gold: 34,   drops: [['madera_oscura', 0.5], ['resina', 0.3]], color: '#4f6b3a', art: 'ent' },
  esqueleto:      { name: 'Esqueleto',           hp: 110,  atk: 24, def: 12, spd: 66, r: 12, aggro: 210, xp: 74,   gold: 44,   drops: [['hueso', 0.5], ['moneda_antigua', 0.25]], color: '#d8d4c4', art: 'esqueleto' },
  golem:          { name: 'Gólem de piedra',     hp: 210,  atk: 28, def: 26, spd: 40, r: 18, aggro: 180, xp: 110,  gold: 60,   drops: [['piedra_runa', 0.45], ['hueso', 0.2]], color: '#6f6a72', art: 'golem' },
  mago_rencoroso: { name: 'Mago rencoroso',      hp: 130,  atk: 34, def: 10, spd: 58, r: 12, aggro: 280, xp: 120,  gold: 96,   drops: [['esencia', 0.4], ['pergamino', 0.3]],  color: '#8f7bd8', art: 'mago' },
  troll:          { name: 'Troll',               hp: 320,  atk: 40, def: 22, spd: 52, r: 20, aggro: 220, xp: 190,  gold: 130,  drops: [['cuero', 0.5], ['esencia', 0.2]],     color: '#6b8f5a', art: 'troll' },
  draconido:      { name: 'Dracónido',           hp: 380,  atk: 48, def: 28, spd: 74, r: 20, aggro: 300, xp: 250,  gold: 180,  drops: [['escama', 0.4], ['esencia', 0.3]],    color: '#c05a3a', art: 'dragon' },
  espectro:       { name: 'Espectro',            hp: 300,  atk: 52, def: 18, spd: 78, r: 14, aggro: 320, xp: 280,  gold: 210,  drops: [['esencia', 0.5], ['reliquia', 0.2]],  color: '#a9b6d8', art: 'espectro' },
  guardian_qarim: { name: 'Guardián de Qarim',   hp: 900,  atk: 56, def: 30, spd: 58, r: 26, aggro: 420, xp: 900,  gold: 600,  boss: true, drops: [['reliquia', 0.7], ['esencia', 0.5]], color: '#d8b45a', art: 'golem' },
  devorador:      { name: 'Devorador de Ceniza', hp: 1400, atk: 72, def: 38, spd: 66, r: 28, aggro: 460, xp: 1600, gold: 950,  boss: true, drops: [['escama', 0.8], ['reliquia', 0.6]], color: '#e06b3a', art: 'dragon' },
  rey_vacio:      { name: 'Rey del Vacío',       hp: 2600, atk: 96, def: 46, spd: 72, r: 32, aggro: 520, xp: 4000, gold: 2000, boss: true, drops: [['reliquia', 1], ['esencia', 1]], color: '#7b5ad8', art: 'espectro' }
};

const ITEMS = {
  cuero:           { name: 'Cuero',            kind: 'material',   price: 6,   icon: 'cu' },
  carne:           { name: 'Carne',            kind: 'material',   price: 5,   icon: 'ca' },
  colmillo:        { name: 'Colmillo',         kind: 'material',   price: 9,   icon: 'co' },
  seda:            { name: 'Seda sombría',     kind: 'material',   price: 14,  icon: 'se' },
  hueso:           { name: 'Hueso',            kind: 'material',   price: 12,  icon: 'hu' },
  piedra_runa:     { name: 'Piedra rúnica',    kind: 'material',   price: 22,  icon: 'pr' },
  madera_oscura:   { name: 'Madera oscura',    kind: 'material',   price: 16,  icon: 'ma' },
  resina:          { name: 'Resina',           kind: 'material',   price: 11,  icon: 're' },
  esencia:         { name: 'Esencia arcana',   kind: 'material',   price: 40,  icon: 'es' },
  escama:          { name: 'Escama de dragón', kind: 'material',   price: 85,  icon: 'ec' },
  moneda_antigua:  { name: 'Moneda antigua',   kind: 'material',   price: 30,  icon: 'mo' },
  reliquia:        { name: 'Reliquia',         kind: 'material',   price: 180, icon: 'rl' },
  pergamino:       { name: 'Pergamino',        kind: 'material',   price: 55,  icon: 'pe' },
  hierba:          { name: 'Hierba curativa',  kind: 'consumable', price: 14,  icon: 'hi', heal: 0.35 },
  pan:             { name: 'Pan de viaje',     kind: 'consumable', price: 10,  icon: 'pa', heal: 0.2 },
  elixir:          { name: 'Elixir',           kind: 'consumable', price: 65,  icon: 'el', heal: 1 },
  daga:            { name: 'Daga',             kind: 'weapon',  slot: 'weapon',  price: 40,  atk: 4 },
  espada:          { name: 'Espada corta',     kind: 'weapon',  slot: 'weapon',  price: 120, atk: 9 },
  hacha:           { name: 'Hacha de guerra',  kind: 'weapon',  slot: 'weapon',  price: 260, atk: 15 },
  filo_runa:       { name: 'Filo rúnico',      kind: 'weapon',  slot: 'weapon',  price: 520, atk: 24 },
  tunica:          { name: 'Túnica',           kind: 'armor',   slot: 'armor',   price: 60,  def: 4 },
  cuero_reforzado: { name: 'Cuero reforzado',  kind: 'armor',   slot: 'armor',   price: 180, def: 9 },
  malla:           { name: 'Cota de malla',    kind: 'armor',   slot: 'armor',   price: 380, def: 16 },
  placas:          { name: 'Placas de acero',  kind: 'armor',   slot: 'armor',   price: 700, def: 24 },
  anillo:          { name: 'Anillo de bronce', kind: 'trinket', slot: 'trinket', price: 90,  atk: 2, def: 2 }
};

const NODES = {
  arbol:  { name: 'Árbol',  skill: 'talar',      item: 'madera_oscura', xp: 8,  respawn: 45, color: '#2f5a2f', r: 16 },
  hierba: { name: 'Hierba', skill: 'recolectar', item: 'hierba',        xp: 5,  respawn: 25, color: '#6fae5a', r: 10 },
  piedra: { name: 'Veta',   skill: 'minar',      item: 'piedra_runa',   xp: 12, respawn: 60, color: '#6f6a72', r: 15 }
};

const SKILLS = {
  talar:      { name: 'Talar' },
  minar:      { name: 'Minar' },
  recolectar: { name: 'Recolectar' },
  combate:    { name: 'Combate' }
};

function xpForLevel(level) { return Math.round(50 * Math.pow(level, 1.6)); }

function levelOf(totalXp) {
  let lv = 1, rest = totalXp, guard = 0;
  while (rest >= xpForLevel(lv) && guard++ < 400) { rest -= xpForLevel(lv); lv++; }
  return { level: lv, into: rest, need: xpForLevel(lv) };
}

let WORLD = { regions: [], towns: [], dungeons: [], seed: 1 };

function buildRegions(seed) {
  const r = rngFor(seed ^ 0x9e3779b9);
  const towns = [
    { id: 'robledal', name: 'Robledal',          x: 18,  y: 118, r: 9, safe: true, services: ['posada', 'mercader', 'forja', 'misiones'] },
    { id: 'qarim',    name: 'Puesto de Qarim',   x: 108, y: 96,  r: 7, safe: true, services: ['posada', 'mercader', 'misiones'] },
    { id: 'ceniza',   name: 'Refugio de Ceniza', x: 128, y: 30,  r: 6, safe: true, services: ['posada', 'mercader'] }
  ];

  const regions = [
    { id: 'pradera_sur',    biome: 'pradera', x: 0,   y: 96, w: 72,  h: 64 },
    { id: 'bosque_oeste',   biome: 'bosque',  x: 0,   y: 40, w: 64,  h: 56 },
    { id: 'bosque_norte',   biome: 'bosque',  x: 0,   y: 0,  w: 56,  h: 40 },
    { id: 'ruinas_centro',  biome: 'ruinas',  x: 64,  y: 40, w: 56,  h: 56 },
    { id: 'pradera_este',   biome: 'pradera', x: 72,  y: 96, w: 88,  h: 64 },
    { id: 'ruinas_este',    biome: 'ruinas',  x: 120, y: 40, w: 40,  h: 56 },
    { id: 'ceniza_norte',   biome: 'ceniza',  x: 56,  y: 0,  w: 72,  h: 40 },
    { id: 'nieve_noroeste', biome: 'nieve',   x: 128, y: 0,  w: 32,  h: 40 }
  ];

  const river = { pts: [], w: 3 };
  let rx = 6, ry = 60;
  for (let i = 0; i < 34; i++) {
    river.pts.push({ x: rx, y: ry });
    rx += 1.4 + r() * 1.6;
    ry += Math.sin(i * 0.42) * 2.4;
  }
  const lake = { x: 88, y: 104, r: 7 };

  const dungeons = [
    { id: 'cripta_qarim',   name: 'Cripta de Qarim',  x: 88,  y: 62, level: 10, boss: 'guardian_qarim', dungeonSeed: (seed ^ 0x51ed2701) >>> 0 },
    { id: 'caverna_ceniza', name: 'Caverna Ardiente', x: 96,  y: 22, level: 17, boss: 'devorador',      dungeonSeed: (seed ^ 0x2545f491) >>> 0 },
    { id: 'foso_vacio',     name: 'Foso del Vacío',   x: 142, y: 14, level: 24, boss: 'rey_vacio',      dungeonSeed: (seed ^ 0x1b56c4e5) >>> 0 }
  ];

  return { regions: regions, towns: towns, dungeons: dungeons, river: river, lake: lake, seed: seed };
}

function initWorld(seed) {
  WORLD = buildRegions(seed);
  return WORLD;
}

function terrainAt(x, y) {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return 'deep';
  const wx = WORLD;
  if (wx.river) {
    for (let i = 0; i < wx.river.pts.length - 1; i++) {
      const a = wx.river.pts[i], b = wx.river.pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      let t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const px = a.x + dx * t, py = a.y + dy * t;
      if (Math.hypot(px - x, py - y) < wx.river.w) return 'water';
    }
  }
  if (wx.lake && Math.hypot(wx.lake.x - x, wx.lake.y - y) < wx.lake.r) return 'water';

  let region = null;
  for (let i = 0; i < wx.regions.length; i++) {
    const rg = wx.regions[i];
    if (x >= rg.x && y >= rg.y && x < rg.x + rg.w && y < rg.y + rg.h) { region = rg; break; }
  }
  if (!region) return 'deep';
  const biome = BIOMES[region.biome];
  const n = hash2(x, y, 11);
  if (biome.terrain === 'snow') return n < 0.86 ? 'snow' : 'rock';
  if (biome.terrain === 'rock') return n < 0.88 ? 'rock' : 'sand';
  if (biome.terrain === 'darkgrass') return n < 0.9 ? 'darkgrass' : 'grass';
  return n < 0.9 ? 'grass' : 'darkgrass';
}

function walkable(x, y) {
  const t = terrainAt(x, y);
  return TERRAIN[t] ? TERRAIN[t].walk : false;
}

function nodeAt(x, y) {
  if (!walkable(x, y)) return null;
  const biome = biomeAt(x, y);
  if (!biome) return null;
  const n = hash2(x, y, 23);
  let acc = 0;
  for (const key in biome.nodes) {
    acc += biome.nodes[key];
    if (n < acc) return { type: key, x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 };
  }
  return null;
}

function biomeAt(x, y) {
  for (let i = 0; i < WORLD.regions.length; i++) {
    const rg = WORLD.regions[i];
    if (x >= rg.x && y >= rg.y && x < rg.x + rg.w && y < rg.y + rg.h) return BIOMES[rg.biome];
  }
  return null;
}

function townAt(x, y) {
  for (let i = 0; i < WORLD.towns.length; i++) {
    const t = WORLD.towns[i];
    if (Math.hypot(t.x - x, t.y - y) <= t.r) return t;
  }
  return null;
}

function dungeonAt(x, y) {
  for (let i = 0; i < WORLD.dungeons.length; i++) {
    const d = WORLD.dungeons[i];
    if (Math.hypot(d.x - x, d.y - y) <= 2.2) return d;
  }
  return null;
}

function spawnEnemy(biome, x, y, level) {
  const id = pickWeighted(biome.enemies, biome.weights, x, y, 31);
  const base = MONSTERS[id];
  const lv = level || levelForBiome(biome, x, y);
  const k = 1 + (lv - 1) * 0.14;
  return {
    type: id, name: base.name, art: base.art, color: base.color,
    x: x, y: y, r: base.r, hp: Math.round(base.hp * k), maxHp: Math.round(base.hp * k),
    atk: Math.round(base.atk * k), def: Math.round(base.def * k),
    spd: base.spd, aggro: base.aggro, xp: Math.round(base.xp * (1 + (lv - 1) * 0.1)),
    gold: Math.round(base.gold * (1 + (lv - 1) * 0.1)), level: lv, boss: !!base.boss,
    drops: base.drops, dir: 0, vx: 0, vy: 0, wanderT: 0, homeX: x, homeY: y, state: 'idle'
  };
}

function levelForBiome(biome, x, y) {
  const range = biome.level || [1, 3];
  const t = hash2(Math.floor(x), Math.floor(y), 47);
  return Math.round(range[0] + (range[1] - range[0]) * t);
}

function pickWeighted(ids, weights, x, y, salt) {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  let roll = hash2(Math.floor(x), Math.floor(y), salt) * total;
  for (let i = 0; i < ids.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return ids[i];
  }
  return ids[ids.length - 1];
}

const AethelShared = {
  RNG: { mulberry32: mulberry32, rngFor: rngFor, hash2: hash2 },
  TILE: TILE, MAP_W: MAP_W, MAP_H: MAP_H, TICK_MS: TICK_MS,
  TERRAIN: TERRAIN, BIOMES: BIOMES, MONSTERS: MONSTERS, ITEMS: ITEMS,
  NODES: NODES, SKILLS: SKILLS,
  xpForLevel: xpForLevel, levelOf: levelOf,
  initWorld: initWorld, buildRegions: buildRegions,
  terrainAt: terrainAt, walkable: walkable, nodeAt: nodeAt, biomeAt: biomeAt,
  townAt: townAt, dungeonAt: dungeonAt,
  spawnEnemy: spawnEnemy, levelForBiome: levelForBiome, pickWeighted: pickWeighted,
  get world() { return WORLD; }
};

root.AethelShared = AethelShared;
if (typeof module !== 'undefined' && module.exports) module.exports = AethelShared;

})(typeof globalThis !== 'undefined' ? globalThis : this);
