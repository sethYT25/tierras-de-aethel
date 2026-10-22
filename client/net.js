/* =========================================================================
   TIERRAS DE AETHEL — Conexión, predicción e interpolación

   El servidor envía el estado diez veces por segundo. Para que el juego se
   sienta inmediato:
     · el jugador local predice su propio movimiento con la misma velocidad
       que el servidor y se corrige suavemente cuando llega el estado real;
     · el resto de entidades se dibuja interpolando entre los dos últimos
       estados recibidos, un poco por detrás del presente.
   ========================================================================= */
(function (root) {
'use strict';

const Sh = root.AethelShared;
const TILE = Sh.TILE;

const Net = {
  ws: null,
  connected: false,
  id: null,
  seed: 0,
  online: 0,
  snapshots: [],
  state: null,
  interpDelay: 140,
  lastRecv: 0,
  handlers: {},
  self: { x: 0, y: 0, dir: 0, hp: 0, maxHp: 0 },
  name: 'Aventurero',
  cls: 'guerrero',

  on(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
  emit(type, data) {
    const list = this.handlers[type];
    if (list) for (let i = 0; i < list.length; i++) list[i](data);
  },

  url() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host;
  },

  connect(name, cls) {
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
    const ws = new WebSocket(this.url());
    this.ws = ws;
    this.name = name;
    this.cls = cls;
    ws.onopen = () => {
      this.connected = true;
      this.send({ t: 'join', name: name, cls: cls });
      this.emit('open');
    };
    ws.onclose = () => { this.connected = false; this.emit('close'); };
    ws.onerror = () => this.emit('error');
    ws.onmessage = ev => this.onMessage(ev.data);
    return ws;
  },

  send(msg) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(msg));
  },

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    this.lastRecv = performance.now();
    switch (msg.t) {
      case 'welcome':
        this.id = msg.id;
        this.seed = msg.seed;
        Sh.initWorld(msg.seed);
        this.emit('welcome', msg);
        break;
      case 'state':
        this.absorb(msg);
        break;
      default:
        this.emit(msg.t, msg);
    }
  },

  absorb(msg) {
    this.online = msg.online;
    this.snapshots.push({ at: performance.now(), data: msg });
    if (this.snapshots.length > 6) this.snapshots.shift();
    this.state = msg;
    const you = msg.you;
    if (you) {
      this.self.hp = you.hp;
      this.self.maxHp = you.maxHp;
      const dx = you.x - this.self.x;
      const dy = you.y - this.self.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 90) { this.self.x = you.x; this.self.y = you.y; }
      else { this.self.x += dx * 0.18; this.self.y += dy * 0.18; }
      this.self.dir = you.dir;
    }
    this.emit('state', msg);
  },

  predict(dt, input, speed) {
    let dx = 0, dy = 0;
    if (input.up) dy -= 1;
    if (input.down) dy += 1;
    if (input.left) dx -= 1;
    if (input.right) dx += 1;
    if (!dx && !dy) return;
    const len = Math.hypot(dx, dy);
    const step = speed * dt;
    const nx = this.self.x + (dx / len) * step;
    const ny = this.self.y + (dy / len) * step;
    if (Sh.walkable(Math.floor(nx / TILE), Math.floor(this.self.y / TILE))) this.self.x = nx;
    if (Sh.walkable(Math.floor(this.self.x / TILE), Math.floor(ny / TILE))) this.self.y = ny;
    this.self.dir = Math.atan2(dy, dx);
  },

  interpAt(history, now) {
    if (!history || !history.length) return null;
    const target = now - this.interpDelay;
    let a = history[0], b = history[history.length - 1];
    for (let i = 0; i < history.length - 1; i++) {
      if (history[i].at <= target && history[i + 1].at >= target) { a = history[i]; b = history[i + 1]; break; }
      a = history[i + 1]; b = history[i + 1];
    }
    const span = b.at - a.at;
    const t = span > 0 ? Math.max(0, Math.min(1, (target - a.at) / span)) : 1;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dir: b.dir };
  }
};

root.AethelNet = Net;
})(typeof globalThis !== 'undefined' ? globalThis : this);
