/* =========================================================================
   TIERRAS DE AETHEL — Servidor autoritativo

   Dos responsabilidades:
     1. Servir los archivos del juego por HTTP (sin dependencias).
     2. Mantener la verdad del mundo por WebSocket: posiciones, monstruos,
        daño, botín, chat y mazmorras.

   El cliente solo envía intenciones y recibe estado. Nada de lo que diga el
   cliente se cree sin comprobarlo.
   ========================================================================= */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Shared = require('../shared/game-data.js');

const PORT = process.env.PORT || 8080;
const WORLD_SEED = Number(process.env.WORLD_SEED || 20260101);
const TICK_MS = Shared.TICK_MS;
const TILE = Shared.TILE;
const ROOT = path.join(__dirname, '..');

Shared.initWorld(WORLD_SEED);

const state = {
  tick: 0,
  players: new Map(),
  monsters: new Map(),
  chats: [],
  nextId: 1,
  rng: Shared.RNG.rngFor(WORLD_SEED ^ 0x5bf03635)
};

function uid(prefix) { return prefix + (state.nextId++); }

/* ------------------------------ JUGADORES ------------------------------- */
function makePlayer(name, cls) {
  const spawn = Shared.world.towns[0];
  return {
    id: uid('p'),
    name: String(name || 'Aventurero').slice(0, 16),
    cls: cls || 'guerrero',
    x: spawn.x * TILE + (Math.random() * 40 - 20),
    y: spawn.y * TILE + (Math.random() * 40 - 20),
    dir: 0,
    hp: 120, maxHp: 120,
    xp: 0, level: 1, gold: 40,
    weapon: null, armor: null, trinket: null,
    bag: {},
    skills: { talar: 0, minar: 0, recolectar: 0, combate: 0 },
    skillLevels: { talar: 1, minar: 1, recolectar: 1, combate: 1 },
    kills: 0, deaths: 0,
    lastMove: 0, lastAttack: 0, lastGather: 0, lastSay: 0,
    invulnUntil: 0, respawnAt: 0,
    input: { up: false, down: false, left: false, right: false },
    dungeon: null,
    ws: null
  };
}

function playerAttack(p) {
  const w = p.weapon ? Shared.ITEMS[p.weapon] : null;
  const t = p.trinket ? Shared.ITEMS[p.trinket] : null;
  return 8 + p.level * 2 + ((w && w.atk) || 0) + ((t && t.atk) || 0);
}

function playerDefense(p) {
  const a = p.armor ? Shared.ITEMS[p.armor] : null;
  const t = p.trinket ? Shared.ITEMS[p.trinket] : null;
  return 2 + p.level + ((a && a.def) || 0) + ((t && t.def) || 0);
}

function playerMaxHp(p) { return 100 + p.level * 20 + (p.cls === 'guerrero' ? 40 : 0); }
function playerSpeed(p) { return p.cls === 'picaro' ? 160 : (p.cls === 'mago' ? 132 : 145); }

function grantXp(p, amount) {
  p.xp += amount;
  const lv = Shared.levelOf(p.xp);
  if (lv.level > p.level) {
    p.level = lv.level;
    p.maxHp = playerMaxHp(p);
    p.hp = p.maxHp;
    send(p, { t: 'levelup', level: p.level, maxHp: p.maxHp });
    broadcastEvent(p.name + ' alcanza el nivel ' + p.level + '.');
  }
}

/* ------------------------------- MONSTRUOS ------------------------------ */
let spawnAccum = 0;
const MAX_MONSTERS = Number(process.env.MAX_MONSTERS || 420);

function trySpawnMonster() {
  if (state.monsters.size >= MAX_MONSTERS) return;
  const r = state.rng;
  for (let attempt = 0; attempt < 12; attempt++) {
    const tx = Math.floor(r() * (Shared.MAP_W - 4)) + 2;
    const ty = Math.floor(r() * (Shared.MAP_H - 4)) + 2;
    if (!Shared.walkable(tx, ty)) continue;
    const biome = Shared.biomeAt(tx, ty);
    if (!biome) continue;
    if (Shared.townAt(tx, ty)) continue;
    const x = tx * TILE + TILE / 2;
    const y = ty * TILE + TILE / 2;
    let tooClose = false;
    for (const p of state.players.values()) {
      if (Math.hypot(p.x - x, p.y - y) < 320) { tooClose = true; break; }
    }
    if (tooClose) continue;
    const m = Shared.spawnEnemy(biome, x, y);
    m.id = uid('m');
    state.monsters.set(m.id, m);
    return;
  }
}

function spawnBoss(dungeon) {
  const base = Shared.MONSTERS[dungeon.boss];
  const m = {
    id: uid('m'), type: dungeon.boss, name: base.name, art: base.art, color: base.color,
    x: dungeon.x * TILE, y: dungeon.y * TILE, r: base.r,
    hp: base.hp, maxHp: base.hp, atk: base.atk, def: base.def, spd: base.spd,
    aggro: base.aggro, xp: base.xp, gold: base.gold, level: dungeon.level + 2,
    boss: true, drops: base.drops, dir: 0, vx: 0, vy: 0, wanderT: 0,
    homeX: dungeon.x * TILE, homeY: dungeon.y * TILE, state: 'idle',
    dungeon: dungeon.id
  };
  state.monsters.set(m.id, m);
  return m;
}

/* ---------------------------- COMBATE Y MOVIMIENTO ---------------------- */
function moveMonster(m, dt) {
  m.wanderT -= dt;
  let target = null;
  for (const p of state.players.values()) {
    if (p.hp <= 0) continue;
    if (Math.hypot(p.x - m.x, p.y - m.y) < m.aggro) { target = p; break; }
  }
  let tx, ty;
  if (target) {
    tx = target.x; ty = target.y; m.state = 'chase';
  } else {
    if (m.wanderT <= 0) {
      m.wanderT = 2 + state.rng() * 3;
      m.wanderX = m.homeX + (state.rng() * 220 - 110);
      m.wanderY = m.homeY + (state.rng() * 220 - 110);
    }
    tx = m.wanderX == null ? m.homeX : m.wanderX;
    ty = m.wanderY == null ? m.homeY : m.wanderY;
    m.state = 'idle';
  }

  if (m.dungeon) {
    const d = Shared.world.dungeons.filter(x => x.id === m.dungeon)[0];
    if (d) {
      const cx = d.x * TILE, cy = d.y * TILE;
      if (Math.hypot(m.x - cx, m.y - cy) > 360) { tx = cx; ty = cy; }
    }
  }

  const dx = tx - m.x, dy = ty - m.y;
  const dist = Math.hypot(dx, dy);
  if (dist > 4) {
    const speed = m.spd * (m.state === 'chase' ? 1 : 0.55);
    const nx = dx / dist, ny = dy / dist;
    const step = speed * dt;
    const nxtX = m.x + nx * step;
    const nxtY = m.y + ny * step;
    if (Shared.walkable(Math.floor(nxtX / TILE), Math.floor(m.y / TILE))) m.x = nxtX;
    if (Shared.walkable(Math.floor(m.x / TILE), Math.floor(nxtY / TILE))) m.y = nxtY;
    m.dir = Math.atan2(ny, nx);
    m.vx = nx * speed; m.vy = ny * speed;
  } else {
    m.vx = m.vy = 0;
  }

  if (target) {
    const d = Math.hypot(target.x - m.x, target.y - m.y);
    if (d < m.r + 16 && state.tick % 6 === 0) hitPlayer(target, m.atk, m);
  }
}

function hitPlayer(p, rawAtk, source) {
  if (p.hp <= 0) return;
  if (p.invulnUntil > Date.now()) return;
  if (Shared.townAt(Math.floor(p.x / TILE), Math.floor(p.y / TILE))) return;
  const def = playerDefense(p);
  const dmg = Math.max(1, Math.round(rawAtk * (1 - def / (def + 60)) * (0.9 + Math.random() * 0.2)));
  p.hp = Math.max(0, p.hp - dmg);
  send(p, { t: 'hurt', amount: dmg, from: source ? source.name : '', hp: p.hp });
  if (p.hp <= 0) {
    p.deaths++;
    p.respawnAt = Date.now() + 4000;
    broadcastEvent(p.name + ' ha caído en combate.');
  }
}

function attackFrom(p, monsterId) {
  const now = Date.now();
  if (now - p.lastAttack < 320) return;
  p.lastAttack = now;
  const m = state.monsters.get(monsterId);
  if (!m || m.hp <= 0) { gather(p); return; }
  const dist = Math.hypot(m.x - p.x, m.y - p.y);
  if (dist > m.r + 44) { send(p, { t: 'note', text: 'Está demasiado lejos.' }); return; }
  const dmg = Math.max(1, Math.round(playerAttack(p) * (1 - m.def / (m.def + 55)) * (0.9 + Math.random() * 0.25)));
  m.hp -= dmg;
  send(p, { t: 'hitMonster', id: m.id, amount: dmg, hp: m.hp, x: m.x, y: m.y });
  if (m.hp <= 0) killMonster(m, p);
}

function killMonster(m, p) {
  state.monsters.delete(m.id);
  p.gold += m.gold;
  p.kills++;
  grantXp(p, m.xp);
  const loot = {};
  for (const d of m.drops) if (Math.random() < d[1]) loot[d[0]] = (loot[d[0]] || 0) + 1;
  for (const it in loot) addItem(p, it, loot[it]);
  p.skills.combate += m.xp;
  p.skillLevels.combate = Shared.levelOf(p.skills.combate).level;
  send(p, { t: 'kill', name: m.name, xp: m.xp, gold: m.gold, loot: loot, x: m.x, y: m.y });
  if (m.boss) broadcastEvent(p.name + ' ha derrotado a ' + m.name + '.');
}

function addItem(p, item, n) { p.bag[item] = (p.bag[item] || 0) + n; }

function gather(p) {
  const now = Date.now();
  if (now - p.lastGather < 500) return;
  p.lastGather = now;
  const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
  let best = null, bestD = 1e9;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const n = Shared.nodeAt(tx + dx, ty + dy);
      if (!n) continue;
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < bestD) { bestD = d; best = n; }
    }
  }
  if (!best || bestD > 56) { send(p, { t: 'note', text: 'No hay nada que recolectar aquí.' }); return; }
  const def = Shared.NODES[best.type];
  addItem(p, def.item, 1);
  p.skills[def.skill] += def.xp;
  p.skillLevels[def.skill] = Shared.levelOf(p.skills[def.skill]).level;
  send(p, { t: 'gather', item: def.item, skill: def.skill, level: p.skillLevels[def.skill], x: best.x, y: best.y });
}

/* ------------------------------- MAZMORRAS ------------------------------ */
function enterDungeon(p) {
  const d = Shared.dungeonAt(Math.floor(p.x / TILE), Math.floor(p.y / TILE));
  if (!d) { send(p, { t: 'note', text: 'No hay ninguna entrada cerca.' }); return; }
  p.dungeon = d.id;
  send(p, { t: 'dungeon', action: 'enter', name: d.name, level: d.level });
  const hasBoss = [...state.monsters.values()].some(m => m.dungeon === d.id && m.boss);
  if (!hasBoss) spawnBoss(d);
}

/* -------------------------------- COMERCIO ------------------------------ */
const SHOP = ['hierba', 'pan', 'elixir', 'daga', 'espada', 'hacha', 'filo_runa', 'tunica', 'cuero_reforzado', 'malla', 'placas', 'anillo'];

function buy(p, item) {
  if (!Shared.townAt(Math.floor(p.x / TILE), Math.floor(p.y / TILE))) return;
  const def = Shared.ITEMS[item];
  if (!def || SHOP.indexOf(item) < 0) return;
  if (p.gold < def.price) { send(p, { t: 'note', text: 'No tienes oro suficiente.' }); return; }
  p.gold -= def.price;
  if (def.slot) {
    const prev = def.slot === 'weapon' ? p.weapon : (def.slot === 'armor' ? p.armor : p.trinket);
    if (prev) addItem(p, prev, 1);
    if (def.slot === 'weapon') p.weapon = item;
    else if (def.slot === 'armor') p.armor = item;
    else p.trinket = item;
  } else {
    addItem(p, item, 1);
  }
  send(p, { t: 'shop', gold: p.gold, bag: p.bag, weapon: p.weapon, armor: p.armor, trinket: p.trinket });
}

function sell(p, item) {
  if (!Shared.townAt(Math.floor(p.x / TILE), Math.floor(p.y / TILE))) return;
  const def = Shared.ITEMS[item];
  if (!def || !p.bag[item]) return;
  p.bag[item]--;
  if (p.bag[item] <= 0) delete p.bag[item];
  p.gold += Math.max(1, Math.floor(def.price * 0.4));
  send(p, { t: 'shop', gold: p.gold, bag: p.bag, weapon: p.weapon, armor: p.armor, trinket: p.trinket });
}

function equip(p, item) {
  const def = Shared.ITEMS[item];
  if (!def || !def.slot || !p.bag[item]) return;
  p.bag[item]--;
  if (p.bag[item] <= 0) delete p.bag[item];
  const prev = def.slot === 'weapon' ? p.weapon : (def.slot === 'armor' ? p.armor : p.trinket);
  if (prev) addItem(p, prev, 1);
  if (def.slot === 'weapon') p.weapon = item;
  else if (def.slot === 'armor') p.armor = item;
  else p.trinket = item;
  send(p, { t: 'shop', gold: p.gold, bag: p.bag, weapon: p.weapon, armor: p.armor, trinket: p.trinket });
}

function useItem(p, item) {
  const def = Shared.ITEMS[item];
  if (!def || def.kind !== 'consumable' || !p.bag[item]) return;
  p.bag[item]--;
  if (p.bag[item] <= 0) delete p.bag[item];
  const heal = Math.round(p.maxHp * (def.heal || 0));
  p.hp = Math.min(p.maxHp, p.hp + heal);
  send(p, { t: 'heal', amount: heal, hp: p.hp, bag: p.bag });
}

function rest(p) {
  const town = Shared.townAt(Math.floor(p.x / TILE), Math.floor(p.y / TILE));
  if (!town || town.services.indexOf('posada') < 0) return;
  const cost = 15;
  if (p.gold < cost) { send(p, { t: 'note', text: 'Necesitas 15 de oro para dormir.' }); return; }
  p.gold -= cost;
  p.hp = p.maxHp;
  p.invulnUntil = Date.now() + 1200;
  send(p, { t: 'rest', hp: p.hp, gold: p.gold });
}

/* ---------------------------------- RED --------------------------------- */
function send(p, msg) {
  if (!p.ws || p.ws.readyState !== 1) return;
  try { p.ws.send(JSON.stringify(msg)); } catch (e) { /* conexión rota */ }
}

function broadcastEvent(text) {
  if (!text) return;
  state.chats.push({ kind: 'system', text: text, at: Date.now(), name: '' });
  if (state.chats.length > 60) state.chats.shift();
  for (const q of state.players.values()) send(q, { t: 'chat', kind: 'system', text: text });
}

function visibleTo(p) {
  const players = [], monsters = [];
  for (const q of state.players.values()) {
    if (q.id === p.id) continue;
    if (Math.hypot(q.x - p.x, q.y - p.y) < 900) players.push(q);
  }
  for (const m of state.monsters.values()) {
    if (Math.hypot(m.x - p.x, m.y - p.y) < 900) monsters.push(m);
  }
  return { players: players, monsters: monsters };
}

function snapshotFor(p, full) {
  const vis = visibleTo(p);
  const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
  const town = Shared.townAt(tx, ty);
  const dungeon = Shared.dungeonAt(tx, ty);
  const biome = Shared.biomeAt(tx, ty);
  const snap = {
    t: 'state', tick: state.tick, time: Date.now(), online: state.players.size,
    you: {
      id: p.id, x: p.x, y: p.y, dir: p.dir,
      hp: p.hp, maxHp: p.maxHp, level: p.level, xp: p.xp, gold: p.gold,
      kills: p.kills, deaths: p.deaths, cls: p.cls,
      skills: p.skillLevels, bag: p.bag,
      weapon: p.weapon, armor: p.armor, trinket: p.trinket,
      dead: p.hp <= 0, respawnAt: p.respawnAt, invuln: p.invulnUntil > Date.now()
    },
    players: vis.players.map(q => ({ id: q.id, name: q.name, cls: q.cls, x: q.x, y: q.y, hp: q.hp, level: q.level, dir: q.dir })),
    monsters: vis.monsters.map(m => ({ id: m.id, type: m.type, name: m.name, art: m.art, color: m.color, x: m.x, y: m.y, vx: m.vx, vy: m.vy, hp: m.hp, maxHp: m.maxHp, r: m.r, level: m.level, boss: m.boss, dir: m.dir, state: m.state })),
    zone: biome ? biome.name : 'Tierras salvajes',
    town: town ? { name: town.name, services: town.services } : null,
    dungeon: dungeon ? { name: dungeon.name, level: dungeon.level } : null
  };
  if (full) snap.chat = state.chats.slice(-14);
  return snap;
}

function sendState() {
  for (const p of state.players.values()) send(p, snapshotFor(p, false));
}

/* -------------------------------- WEBSOCKET ----------------------------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function writeFrame(socket, str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x81;
  try { socket.write(Buffer.concat([header, payload])); } catch (e) { /* cerrado */ }
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + acceptKey(key),
    '\r\n'
  ].join('\r\n'));
  socket.setNoDelay(true);
  const conn = { socket: socket, buffer: Buffer.alloc(0) };
  const p = makePlayer('Aventurero', 'guerrero');
  p.ws = { readyState: 1, send: function (str) { writeFrame(socket, str); } };
  socket.on('data', chunk => onData(conn, p, chunk));
  socket.on('error', () => cleanup(p));
  socket.on('close', () => cleanup(p));
  state.players.set(p.id, p);
  send(p, { t: 'welcome', id: p.id, seed: WORLD_SEED, world: { w: Shared.MAP_W, h: Shared.MAP_H, tile: TILE }, online: state.players.size });
}

function cleanup(p) {
  if (!state.players.has(p.id)) return;
  state.players.delete(p.id);
  broadcastEvent(p.name + ' abandona Aethel.');
}

function onData(conn, p, chunk) {
  conn.buffer = Buffer.concat([conn.buffer, chunk]);
  for (;;) {
    const buf = conn.buffer;
    if (buf.length < 2) return;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) return;
    const mask = masked ? buf.slice(offset, offset + 4) : null;
    const start = offset + maskLen;
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = masked ? buf[start + i] ^ mask[i % 4] : buf[start + i];
    conn.buffer = buf.slice(start + len);

    if (opcode === 0x8) { try { conn.socket.end(); } catch (e) {} return; }
    if (opcode !== 0x1 || !fin) continue;
    let msg = null;
    try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
    handleMessage(p, msg);
  }
}

function handleMessage(p, msg) {
  switch (msg.t) {
    case 'join': {
      p.name = String(msg.name || 'Aventurero').slice(0, 16).replace(/[<>]/g, '') || 'Aventurero';
      p.cls = ['guerrero', 'mago', 'picaro'].indexOf(msg.cls) >= 0 ? msg.cls : 'guerrero';
      p.maxHp = playerMaxHp(p);
      p.hp = p.maxHp;
      send(p, { t: 'joined', name: p.name, cls: p.cls, maxHp: p.maxHp });
      broadcastEvent(p.name + ' entra en Aethel.');
      send(p, snapshotFor(p, true));
      break;
    }
    case 'input':
      p.input.up = !!msg.up; p.input.down = !!msg.down;
      p.input.left = !!msg.left; p.input.right = !!msg.right;
      break;
    case 'attack': attackFrom(p, msg.id); break;
    case 'gather': gather(p); break;
    case 'enter': enterDungeon(p); break;
    case 'buy': buy(p, msg.item); break;
    case 'sell': sell(p, msg.item); break;
    case 'equip': equip(p, msg.item); break;
    case 'use': useItem(p, msg.item); break;
    case 'rest': rest(p); break;
    case 'respawn': {
      if (Date.now() < p.respawnAt) break;
      const town = Shared.world.towns[0];
      p.x = town.x * TILE; p.y = town.y * TILE;
      p.hp = p.maxHp;
      p.invulnUntil = Date.now() + 2500;
      send(p, { t: 'respawned', hp: p.hp });
      break;
    }
    case 'chat': {
      const now = Date.now();
      if (now - p.lastSay < 700) break;
      p.lastSay = now;
      const text = String(msg.text || '').slice(0, 140).replace(/[<>]/g, '');
      if (!text.trim()) break;
      state.chats.push({ kind: 'say', name: p.name, text: text, at: now });
      if (state.chats.length > 60) state.chats.shift();
      for (const q of state.players.values()) send(q, { t: 'chat', kind: 'say', name: p.name, text: text });
      break;
    }
    case 'sync': send(p, snapshotFor(p, true)); break;
    default: break;
  }
}

/* --------------------------------- BUCLE -------------------------------- */
const DT = TICK_MS / 1000;

setInterval(() => {
  state.tick++;

  for (const p of state.players.values()) {
    if (p.hp <= 0) continue;
    let dx = 0, dy = 0;
    if (p.input.up) dy -= 1;
    if (p.input.down) dy += 1;
    if (p.input.left) dx -= 1;
    if (p.input.right) dx += 1;
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      const sp = playerSpeed(p) * DT;
      const nx = p.x + (dx / len) * sp;
      const ny = p.y + (dy / len) * sp;
      if (Shared.walkable(Math.floor(nx / TILE), Math.floor(p.y / TILE))) p.x = nx;
      if (Shared.walkable(Math.floor(p.x / TILE), Math.floor(ny / TILE))) p.y = ny;
      p.dir = Math.atan2(dy, dx);
    }
  }

  for (const m of state.monsters.values()) moveMonster(m, DT);

  spawnAccum += DT;
  if (spawnAccum > 0.7) { spawnAccum = 0; trySpawnMonster(); }

  if (state.tick % 30 === 0) {
    for (const p of state.players.values()) {
      if (p.hp <= 0) continue;
      const town = Shared.townAt(Math.floor(p.x / TILE), Math.floor(p.y / TILE));
      let threat = false;
      for (const m of state.monsters.values()) {
        if (Math.hypot(m.x - p.x, m.y - p.y) < m.aggro) { threat = true; break; }
      }
      if (!threat) p.hp = Math.min(p.maxHp, p.hp + (town ? 6 : 2));
    }
  }

  sendState();
}, TICK_MS);

/* ---------------------------- ARCHIVOS ESTÁTICOS ------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Prohibido'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('No encontrado: ' + urlPath); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tick: state.tick, players: state.players.size, monsters: state.monsters.size, seed: WORLD_SEED }));
    return;
  }
  serveStatic(req, res);
});

server.on('upgrade', (req, socket) => {
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  handleUpgrade(req, socket);
});

server.listen(PORT, () => {
  console.log('Tierras de Aethel escuchando en el puerto ' + PORT);
  console.log('Mundo semilla ' + WORLD_SEED + ' · ' + Shared.MAP_W + 'x' + Shared.MAP_H + ' casillas');
  for (let i = 0; i < 200; i++) trySpawnMonster();
  console.log('Monstruos iniciales: ' + state.monsters.size);
});
