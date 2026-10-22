/* =========================================================================
   TIERRAS DE AETHEL — Interfaz, entrada y bucle del cliente

   Une la red (AethelNet) con el dibujo (AethelRender): recoge el teclado,
   predice el movimiento local, manda las intenciones al servidor y pinta el
   mundo con la cámara centrada en el jugador.
   ========================================================================= */
(function (root) {
'use strict';

const Sh = root.AethelShared;
const Net = root.AethelNet;
const R = root.AethelRender;
const TILE = Sh.TILE;

const $ = id => document.getElementById(id);

/* ----------------------------- ESTADO DEL CLIENTE ----------------------- */
const Game = {
  running: false,
  input: { up: false, down: false, left: false, right: false },
  remoteHistory: new Map(),      // id -> [{at,x,y,dir}]
  selfHistory: [],
  state: null,
  self: null,
  chat: [],
  chatOpen: false,
  lastInputSent: 0,
  lastFrame: 0,
  killed: 0,
  gold: 0,
  showHelp: false,
  dead: false
};

/* ------------------------------- ARRANQUE ------------------------------- */
function boot() {
  const canvas = $('screen');
  R.init(canvas);
  window.addEventListener('resize', () => R.resize());
  bindKeys();
  bindMenus();
  $('btnPlay').addEventListener('click', () => join());
  $('btnHelp').addEventListener('click', () => { Game.showHelp = true; renderHelp(); });
  loop(performance.now());
}

function join() {
  const name = ($('nameInput').value || '').trim().slice(0, 16) || 'Aventurero';
  const clsBtn = document.querySelector('.classBtn.sel');
  const cls = clsBtn ? clsBtn.dataset.cls : 'guerrero';
  $('menu').classList.add('hidden');
  $('hud').classList.remove('hidden');
  Net.connect(name, cls);
  Net.on('open', () => {
    setStatus('Conectado. Cargando el mundo...');
  });
  Net.on('close', () => {
    setStatus('Se ha perdido la conexión. Recarga la página.');
  });
  Net.on('welcome', msg => {
    Game.online = msg.online;
    setStatus('');
  });
  Net.on('state', msg => {
    Game.state = msg;
    Game.self = msg.you;
    if (msg.you) {
      Game.gold = msg.you.gold;
      Game.dead = !!msg.you.dead;
    }
    updateHud();
  });
  Net.on('kill', msg => {
    R.addFloat(msg.x, msg.y, '-' + msg.name, '#ffd166');
    R.addPuff(msg.x, msg.y, msg.color || '#ff8fa8', 16);
    toast('Has derrotado a ' + msg.name + '  +' + msg.xp + ' EXP  +' + msg.gold + ' oro');
    for (const it in msg.loot) toast('Consigues ' + itemName(it) + ' x' + msg.loot[it]);
  });
  Net.on('hitMonster', msg => {
    R.addFloat(msg.x, msg.y, String(msg.amount), '#ffe9a8');
    R.addPuff(msg.x, msg.y, '#ffd166', 5);
    R.shake = 0.35;
  });
  Net.on('hurt', msg => {
    R.addFloat(Net.self.x, Net.self.y, '-' + msg.amount, '#ff6b6b');
    R.shake = 0.8;
  });
  Net.on('gather', msg => {
    R.addFloat(msg.x, msg.y, '+' + itemName(msg.item), '#7bffb2');
    R.addPuff(msg.x, msg.y, '#7bffb2', 8);
    toast('Recolectas ' + itemName(msg.item) + ' (nivel de oficio ' + msg.level + ')');
  });
  Net.on('levelup', msg => toast('¡Subes al nivel ' + msg.level + '!'));
  Net.on('note', msg => toast(msg.text));
  Net.on('chat', msg => {
    Game.chat.push(msg);
    if (Game.chat.length > 30) Game.chat.shift();
    renderChat();
  });
  Net.on('dungeon', msg => toast('Entras en ' + msg.name + ' (nivel ' + msg.level + '). Ten cuidado.'));
  Net.on('heal', msg => R.addFloat(Net.self.x, Net.self.y, '+' + msg.amount, '#7bffb2'));
  Net.on('rest', msg => toast('Has descansado. Vida al máximo.'));
  Net.on('shop', msg => { Game.gold = msg.gold; updateShopMoney(); });
}

/* -------------------------------- TECLADO ------------------------------- */
function bindKeys() {
  const map = {
    KeyW: 'up', ArrowUp: 'up',
    KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right'
  };
  window.addEventListener('keydown', ev => {
    if (Game.chatOpen) {
      if (ev.key === 'Enter') { sendChat(); ev.preventDefault(); }
      if (ev.key === 'Escape') { closeChat(); ev.preventDefault(); }
      return;
    }
    if (map[ev.code]) { Game.input[map[ev.code]] = true; ev.preventDefault(); sendInput(); return; }
    switch (ev.code) {
      case 'Space': ev.preventDefault(); doAttack(); break;
      case 'KeyE': ev.preventDefault(); interact(); break;
      case 'KeyF': ev.preventDefault(); gather(); break;
      case 'KeyG': ev.preventDefault(); toggleShop(); break;
      case 'KeyR': ev.preventDefault(); respawn(); break;
      case 'KeyI': ev.preventDefault(); togglePanel('inventory'); break;
      case 'KeyC': ev.preventDefault(); togglePanel('character'); break;
      case 'KeyM': ev.preventDefault(); toggleMap(); break;
      case 'Enter': ev.preventDefault(); openChat(); break;
      case 'Slash': ev.preventDefault(); openChat(); break;
      case 'Escape': ev.preventDefault(); closePanels(); break;
      case 'KeyH': ev.preventDefault(); Game.showHelp = !Game.showHelp; renderHelp(); break;
      default: break;
    }
  });
  window.addEventListener('keyup', ev => {
    if (map[ev.code]) { Game.input[map[ev.code]] = false; sendInput(); }
  });
  window.addEventListener('blur', () => {
    Game.input = { up: false, down: false, left: false, right: false };
    sendInput();
  });
}

function sendInput() {
  Net.send({ t: 'input', up: Game.input.up, down: Game.input.down, left: Game.input.left, right: Game.input.right });
}

/* -------------------------------- ACCIONES ------------------------------ */
function nearestMonster() {
  if (!Game.state) return null;
  const s = Net.self;
  let best = null, bestD = 1e9;
  for (const m of Game.state.monsters) {
    const d = Math.hypot(m.x - s.x, m.y - s.y);
    if (d < bestD) { bestD = d; best = m; }
  }
  return best && bestD < 180 ? best : null;
}

function doAttack() {
  const m = nearestMonster();
  if (!m) { toast('No hay nada cerca que golpear. Pulsa F para recolectar.'); return; }
  Net.send({ t: 'attack', id: m.id });
}

function gather() { Net.send({ t: 'gather' }); }

function interact() {
  if (!Game.state) return;
  const s = Net.self;
  const t = Math.floor(s.x / TILE), ty = Math.floor(s.y / TILE);
  for (const d of Sh.world.dungeons) {
    if (Math.hypot(d.x - t, d.y - ty) <= 2.2) { Net.send({ t: 'enter' }); return; }
  }
  const town = Sh.townAt(t, ty);
  if (town) { openShop(); return; }
  Net.send({ t: 'rest' });
}

function respawn() { Net.send({ t: 'respawn' }); }

/* --------------------------------- CHAT --------------------------------- */
function openChat() {
  if (Game.chatOpen) return;
  Game.chatOpen = true;
  $('chatInputRow').classList.remove('hidden');
  $('chatInput').focus();
}
function closeChat() {
  Game.chatOpen = false;
  $('chatInputRow').classList.add('hidden');
  $('chatInput').value = '';
}
function sendChat() {
  const v = $('chatInput').value.trim();
  if (v) Net.send({ t: 'chat', text: v });
  closeChat();
}

function renderChat() {
  const box = $('chatLog');
  box.innerHTML = '';
  for (const c of Game.chat) {
    const d = document.createElement('div');
    d.className = 'chatLine ' + (c.kind === 'system' ? 'sys' : 'say');
    d.textContent = c.kind === 'system' ? c.text : (c.name + ': ' + c.text);
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }
}

/* --------------------------------- HUD ---------------------------------- */
function updateHud() {
  const y = Game.self;
  if (!y) return;
  $('hpFill').style.width = Math.max(0, Math.min(100, (y.hp / y.maxHp) * 100)) + '%';
  $('hpText').textContent = Math.round(y.hp) + ' / ' + y.maxHp;
  const lv = Sh.levelOf(y.xp);
  $('xpFill').style.width = Math.max(0, Math.min(100, (lv.into / lv.need) * 100)) + '%';
  $('lvText').textContent = 'nv ' + y.level;
  $('goldText').textContent = y.gold;
  $('zoneText').textContent = Game.state.zone + (Game.state.town ? ' · ' + Game.state.town.name : '') + (Game.state.dungeon ? ' · ' + Game.state.dungeon.name : '');
  $('onlineText').textContent = Game.state.online + (Game.state.online === 1 ? ' jugador' : ' jugadores');
  $('deadOverlay').classList.toggle('hidden', !y.dead);
  if (y.dead) {
    const left = Math.max(0, Math.ceil((y.respawnAt - Date.now()) / 1000));
    $('deadText').textContent = left > 0 ? 'Reapareces en ' + left + 's...' : 'Pulsa R para reaparecer en Robledal.';
  }
}

function setStatus(text) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

function itemName(id) { return Sh.ITEMS[id] ? Sh.ITEMS[id].name : id; }

/* ------------------------------- PANELES -------------------------------- */
function closePanels() {
  $('panel').classList.add('hidden');
  $('shopPanel').classList.add('hidden');
  $('bigMap').classList.add('hidden');
  Game.showHelp = false;
  renderHelp();
}
function togglePanel(kind) {
  const p = $('panel');
  if (!p.classList.contains('hidden') && p.dataset.kind === kind) { p.classList.add('hidden'); return; }
  p.dataset.kind = kind;
  p.classList.remove('hidden');
  if (kind === 'inventory') renderInventory();
  else renderCharacter();
}
function toggleMap() {
  const m = $('bigMap');
  m.classList.toggle('hidden');
  if (!m.classList.contains('hidden')) renderBigMap();
}
function toggleShop() {
  const s = $('shopPanel');
  if (!s.classList.contains('hidden')) { s.classList.add('hidden'); return; }
  if (!Game.state || !Game.state.town) { toast('Solo puedes comerciar en un pueblo.'); return; }
  openShop();
}
function openShop() {
  if (!Game.state || !Game.state.town) { toast('Solo puedes comerciar en un pueblo.'); return; }
  $('shopPanel').classList.remove('hidden');
  renderShop();
}
function updateShopMoney() {
  if (!$('shopPanel').classList.contains('hidden')) renderShop();
  updateHud();
}

function renderInventory() {
  const box = $('panelBody');
  const y = Game.self || {};
  const bag = y.bag || {};
  const eq = [['Arma', y.weapon], ['Armadura', y.armor], ['Accesorio', y.trinket]];
  let html = '<h3>Equipamiento</h3><div class="kv">';
  for (const e of eq) html += '<div><span>' + e[0] + '</span><b>' + (e[1] ? itemName(e[1]) : '— vacío —') + '</b></div>';
  html += '</div><h3>Mochila</h3>';
  const keys = Object.keys(bag);
  if (!keys.length) html += '<p class="dim">Vacía. Mata monstruos o recolecta recursos.</p>';
  else {
    html += '<div class="list">';
    for (const k of keys) {
      const def = Sh.ITEMS[k] || { name: k, kind: 'material' };
      const usable = def.kind === 'consumable';
      const equippable = !!def.slot;
      html += '<div class="row"><span class="nm">' + def.name + ' <i>x' + bag[k] + '</i></span>';
      if (usable) html += '<button class="mini" data-use="' + k + '">Usar</button>';
      if (equippable) html += '<button class="mini" data-equip="' + k + '">Equipar</button>';
      html += '<button class="mini" data-sell="' + k + '">Vender ' + Math.max(1, Math.floor((def.price || 1) * 0.4)) + '</button></div>';
    }
    html += '</div>';
  }
  html += '<h3>Oficios</h3><div class="kv">';
  const sk = y.skills || {};
  for (const k in sk) html += '<div><span>' + (Sh.SKILLS[k] ? Sh.SKILLS[k].name : k) + '</span><b>nivel ' + sk[k] + '</b></div>';
  html += '</div>';
  box.innerHTML = html;
  box.querySelectorAll('[data-use]').forEach(b => b.addEventListener('click', () => { Net.send({ t: 'use', item: b.dataset.use }); setTimeout(renderInventory, 120); }));
  box.querySelectorAll('[data-equip]').forEach(b => b.addEventListener('click', () => { Net.send({ t: 'equip', item: b.dataset.equip }); setTimeout(renderInventory, 120); }));
  box.querySelectorAll('[data-sell]').forEach(b => b.addEventListener('click', () => { Net.send({ t: 'sell', item: b.dataset.sell }); setTimeout(renderInventory, 120); }));
}

function renderCharacter() {
  const y = Game.self || {};
  const box = $('panelBody');
  const lv = Sh.levelOf(y.xp || 0);
  const clsName = { guerrero: 'Guerrero', mago: 'Maga', picaro: 'Pícara' }[y.cls] || 'Aventurero';
  const atk = 8 + (y.level || 1) * 2 + ((Sh.ITEMS[y.weapon] && Sh.ITEMS[y.weapon].atk) || 0) + ((Sh.ITEMS[y.trinket] && Sh.ITEMS[y.trinket].atk) || 0);
  const def = 2 + (y.level || 1) + ((Sh.ITEMS[y.armor] && Sh.ITEMS[y.armor].def) || 0) + ((Sh.ITEMS[y.trinket] && Sh.ITEMS[y.trinket].def) || 0);
  box.innerHTML =
    '<h3>Identidad</h3><div class="kv">' +
    '<div><span>Nombre</span><b>' + (y.name || 'Aventurero') + '</b></div>' +
    '<div><span>Clase</span><b>' + clsName + '</b></div>' +
    '<div><span>Nivel</span><b>' + (y.level || 1) + '</b></div>' +
    '<div><span>Experiencia</span><b>' + lv.into + ' / ' + lv.need + '</b></div>' +
    '<div><span>Vida</span><b>' + Math.round(y.hp) + ' / ' + y.maxHp + '</b></div>' +
    '<div><span>Ataque</span><b>' + atk + '</b></div>' +
    '<div><span>Defensa</span><b>' + def + '</b></div>' +
    '<div><span>Oro</span><b>' + (y.gold || 0) + '</b></div>' +
    '<div><span>Monstruos derrotados</span><b>' + (y.kills || 0) + '</b></div>' +
    '<div><span>Muertes</span><b>' + (y.deaths || 0) + '</b></div>' +
    '</div>';
}

function renderShop() {
  const y = Game.self || {};
  const box = $('shopBody');
  const shop = ['hierba', 'pan', 'elixir', 'daga', 'espada', 'hacha', 'filo_runa', 'tunica', 'cuero_reforzado', 'malla', 'placas', 'anillo'];
  let html = '<p class="money">Oro: <b>' + (y.gold || 0) + '</b></p><div class="list">';
  for (const id of shop) {
    const def = Sh.ITEMS[id];
    html += '<div class="row"><span class="nm">' + def.name + '<i>' + (def.kind === 'consumable' ? 'consumible' : 'equipo') + '</i></span>' +
      '<button class="mini" data-buy="' + id + '">Comprar ' + def.price + '</button></div>';
  }
  html += '</div><h3>Vender</h3><div class="list">';
  const bag = y.bag || {};
  const keys = Object.keys(bag);
  if (!keys.length) html += '<p class="dim">No llevas nada que vender.</p>';
  for (const k of keys) {
    const def = Sh.ITEMS[k] || { name: k, price: 1 };
    html += '<div class="row"><span class="nm">' + def.name + ' <i>x' + bag[k] + '</i></span>' +
      '<button class="mini" data-sell2="' + k + '">Vender ' + Math.max(1, Math.floor(def.price * 0.4)) + '</button></div>';
  }
  html += '</div><p class="dim">También puedes descansar en la posada por 15 de oro.</p>';
  box.innerHTML = html;
  box.querySelectorAll('[data-buy]').forEach(b => b.addEventListener('click', () => { Net.send({ t: 'buy', item: b.dataset.buy }); setTimeout(renderShop, 150); }));
  box.querySelectorAll('[data-sell2]').forEach(b => b.addEventListener('click', () => { Net.send({ t: 'sell', item: b.dataset.sell2 }); setTimeout(renderShop, 150); }));
}

function renderHelp() {
  $('helpBox').classList.toggle('hidden', !Game.showHelp);
}

/* -------------------------------- MAPA GRANDE --------------------------- */
function renderBigMap() {
  const c = $('mapCanvas');
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const sx = W / Sh.MAP_W, sy = H / Sh.MAP_H;
  for (let x = 0; x < Sh.MAP_W; x++) {
    for (let y = 0; y < Sh.MAP_H; y++) {
      g.fillStyle = Sh.TERRAIN[Sh.terrainAt(x, y)].color;
      g.fillRect(x * sx, y * sy, sx + 0.6, sy + 0.6);
    }
  }
  g.font = 'bold 13px ui-monospace,monospace';
  g.textAlign = 'center';
  for (const t of Sh.world.towns) {
    g.fillStyle = '#ffe9a8';
    g.beginPath(); g.arc(t.x * sx, t.y * sy, 6, 0, Math.PI * 2); g.fill();
    g.fillText(t.name, t.x * sx, t.y * sy - 12);
  }
  for (const d of Sh.world.dungeons) {
    g.fillStyle = '#c8a8ff';
    g.beginPath(); g.arc(d.x * sx, d.y * sy, 5, 0, Math.PI * 2); g.fill();
    g.fillText(d.name + ' (nv ' + d.level + ')', d.x * sx, d.y * sy - 10);
  }
  if (Game.state) {
    for (const p of Game.state.players) {
      g.fillStyle = '#7fd0ff';
      g.beginPath(); g.arc(p.x / TILE * sx, p.y / TILE * sy, 3, 0, Math.PI * 2); g.fill();
    }
  }
  const s = Net.self;
  g.fillStyle = '#ffe9a8';
  g.beginPath(); g.arc(s.x / TILE * sx, s.y / TILE * sy, 5, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
}

/* ------------------------------ BUCLE PRINCIPAL ------------------------- */
function speeds() {
  const cls = Net.cls;
  return cls === 'picaro' ? 160 : (cls === 'mago' ? 132 : 145);
}

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - (Game.lastFrame || now)) / 1000);
  Game.lastFrame = now;

  if (Net.connected) Net.predict(dt, Game.input, speeds());
  R.updateEffects(dt);

  /* Historial de posiciones para interpolar */
  if (Game.state) {
    const t = performance.now();
    for (const p of Game.state.players) {
      let h = Game.remoteHistory.get(p.id);
      if (!h) { h = []; Game.remoteHistory.set(p.id, h); }
      h.push({ at: t, x: p.x, y: p.y, dir: p.dir });
      if (h.length > 8) h.shift();
    }
    Game.selfHistory.push({ at: t, x: Net.self.x, y: Net.self.y, dir: Net.self.dir });
    if (Game.selfHistory.length > 8) Game.selfHistory.shift();
  }

  draw(now);
  if (now - Game.lastInputSent > 40) { Game.lastInputSent = now; if (Net.connected) sendInput(); }
}

function draw(now) {
  const g = R.ctx;
  const shake = R.shake > 0 ? (Math.random() - 0.5) * R.shake * 6 : 0;
  const self = Net.self;
  R.camX = self.x - R.w / 2 + shake;
  R.camY = self.y - R.h / 2 + shake;

  g.clearRect(0, 0, R.w, R.h);
  g.fillStyle = '#0b0d13';
  g.fillRect(0, 0, R.w, R.h);
  R.drawTerrain(g, R.camX, R.camY);
  R.drawTowns(g, R.camX, R.camY);

  /* puerta de mazmorra cercana */
  let nearDoor = null;
  const stx = Math.floor(self.x / TILE), sty = Math.floor(self.y / TILE);
  for (const d of Sh.world.dungeons) {
    if (Math.hypot(d.x - stx, d.y - sty) <= 2.6) { nearDoor = d; break; }
  }
  R.drawDungeonDoors(g, R.camX, R.camY, nearDoor);
  R.drawNodes(g, R.camX, R.camY);

  /* monstruos y jugadores ordenados por altura para que se solapen bien */
  const drawables = [];
  if (Game.state) {
    for (const m of Game.state.monsters) drawables.push({ y: m.y, kind: 'm', data: m });
    for (const p of Game.state.players) {
      const h = Game.remoteHistory.get(p.id);
      const pos = Net.interpAt(h, now) || { x: p.x, y: p.y, dir: p.dir };
      drawables.push({ y: pos.y, kind: 'p', data: Object.assign({}, p, pos) });
    }
  }
  drawables.push({ y: self.y, kind: 's', data: { x: self.x, y: self.y, dir: self.dir } });
  drawables.sort((a, b) => a.y - b.y);

  for (const d of drawables) {
    if (d.kind === 'm') R.drawMonster(g, d.data, R.camX, R.camY, now);
    else if (d.kind === 'p') R.drawPlayer(g, d.data, R.camX, R.camY, false, now);
    else {
      const y = Game.self || {};
      R.drawPlayer(g, {
        x: d.data.x, y: d.data.y, dir: d.data.dir,
        name: y.name || 'Aventurero', cls: y.cls || 'guerrero', level: y.level || 1,
        hp: y.hp || 1, maxHp: y.maxHp || 1
      }, R.camX, R.camY, true, now);
    }
  }

  R.drawEffects(g, R.camX, R.camY);

  if (!$('bigMap').classList.contains('hidden') && now % 500 < 30) renderBigMap();
}

/* --------------------------------- MENÚ --------------------------------- */
function bindMenus() {
  const btns = document.querySelectorAll('.classBtn');
  btns.forEach(b => b.addEventListener('click', () => {
    btns.forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
  }));
  $('chatInput').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { sendChat(); ev.preventDefault(); }
    if (ev.key === 'Escape') { closeChat(); ev.preventDefault(); }
    ev.stopPropagation();
  });
  document.querySelectorAll('.panelClose').forEach(b => b.addEventListener('click', closePanels));
  $('btnShopClose').addEventListener('click', () => $('shopPanel').classList.add('hidden'));
  $('btnMapClose').addEventListener('click', () => $('bigMap').classList.add('hidden'));
  $('btnRest').addEventListener('click', () => { Net.send({ t: 'rest' }); });
  $('btnRespawn').addEventListener('click', respawn);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

root.AethelGame = Game;
})(typeof globalThis !== 'undefined' ? globalThis : this);
