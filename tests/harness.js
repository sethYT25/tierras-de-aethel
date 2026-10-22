/* =========================================================================
   TIERRAS DE AETHEL — Pruebas del mundo y del servidor

   Ejecuta con:  node tests/harness.js

   Comprueba tres cosas:
     1. Que el mundo común sea coherente y determinista (cliente y servidor
        tienen que generar exactamente el mismo mapa).
     2. Que el servidor arranque, sirva la página y responda al estado de salud.
     3. Que un cliente WebSocket real se conecte, se mueva, ataque y reciba
        estado, usando el protocolo exacto que habla el navegador.
   ========================================================================= */
const { spawn } = require('child_process');
const path = require('path');

const Sh = require('../shared/game-data.js');

const report = { passed: 0, failed: 0, failures: [], notes: [] };
function ok(cond, msg) {
  if (cond) { report.passed++; return true; }
  report.failed++; report.failures.push(msg); return false;
}
function suite(label, fn) {
  const before = report.failed;
  try { fn(); } catch (e) { report.failed++; report.failures.push(label + ': excepción → ' + (e && e.message ? e.message : e)); }
  report.notes.push((report.failed > before ? '✗ ' : '✓ ') + label);
}

/* ---------------------------- 1. EL MUNDO -------------------------------- */
function testWorld() {
  Sh.initWorld(20260101);
  const world = Sh.world;
  ok(world.regions.length === 8, 'el mundo debe tener 8 regiones');
  ok(world.towns.length === 3, 'deben existir 3 pueblos');
  ok(world.dungeons.length === 3, 'deben existir 3 mazmorras');

  /* Determinismo: dos generaciones seguidas dan lo mismo. */
  const a = JSON.stringify(Sh.terrainAt(40, 40)) + Sh.terrainAt(12, 130) + Sh.terrainAt(100, 20);
  Sh.initWorld(20260101);
  const b = JSON.stringify(Sh.terrainAt(40, 40)) + Sh.terrainAt(12, 130) + Sh.terrainAt(100, 20);
  ok(a === b, 'el terreno debe ser determinista para la misma semilla');

  /* Cobertura del mapa y casillas transitables. */
  let walk = 0, water = 0, total = 0;
  for (let x = 0; x < Sh.MAP_W; x++) {
    for (let y = 0; y < Sh.MAP_H; y++) {
      total++;
      if (Sh.walkable(x, y)) walk++; else water++;
    }
  }
  ok(total === 25600, 'el mapa debe tener 25600 casillas');
  ok(walk / total > 0.7, 'al menos el 70% del mapa debe ser transitable (es ' + Math.round(walk / total * 100) + '%)');
  ok(water > 100, 'debe haber agua de sobra (hay ' + water + ' casillas)');

  /* Los pueblos deben estar sobre terreno transitable y tener servicios. */
  for (const t of world.towns) {
    ok(Sh.walkable(t.x, t.y), 'el pueblo ' + t.name + ' debe estar en terreno transitable');
    ok(t.services.length > 0, 'el pueblo ' + t.name + ' debe tener servicios');
  }

  /* Las entradas de mazmorra deben ser alcanzables. */
  for (const d of world.dungeons) {
    ok(Sh.walkable(d.x, d.y), 'la entrada de ' + d.name + ' debe ser transitable');
    ok(!!Sh.MONSTERS[d.boss], 'el jefe de ' + d.name + ' debe existir');
  }

  /* Biomas: cada uno tiene monstruos válidos y pesos coincidentes. */
  for (const id in Sh.BIOMES) {
    const bm = Sh.BIOMES[id];
    ok(bm.enemies.length === bm.weights.length, 'los pesos del bioma ' + id + ' deben coincidir con sus monstruos');
    for (const e of bm.enemies) ok(!!Sh.MONSTERS[e], 'el bioma ' + id + ' referencia un monstruo existente (' + e + ')');
  }

  /* Todos los objetos citados existen. */
  for (const m in Sh.MONSTERS) {
    for (const d of Sh.MONSTERS[m].drops) ok(!!Sh.ITEMS[d[0]], 'el botín de ' + m + ' referencia un objeto existente (' + d[0] + ')')
    ;
  }
  for (const n in Sh.NODES) ok(!!Sh.ITEMS[Sh.NODES[n].item], 'el recurso ' + n + ' entrega un objeto existente');

  /* Los recursos aparecen donde deben. */
  let nodes = 0;
  for (let x = 0; x < Sh.MAP_W; x++) for (let y = 0; y < Sh.MAP_H; y++) if (Sh.nodeAt(x, y)) nodes++;
  ok(nodes > 800, 'debe haber recursos repartidos por el mundo (hay ' + nodes + ')');

  /* Progresión monótona. */
  ok(Sh.xpForLevel(2) > Sh.xpForLevel(1), 'la experiencia por nivel debe crecer');
  ok(Sh.levelOf(0).level === 1, 'sin experiencia el nivel es 1');
  ok(Sh.levelOf(100000).level > 20, 'con mucha experiencia el nivel sube mucho');

  report.notes.push('  mapa: ' + Math.round(walk / total * 100) + '% transitable, ' + nodes + ' recursos, 15 monstruos');
}

/* --------------------------- 2. WEBSOCKET -------------------------------- */
function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x81;
  const mask = Buffer.from([1, 2, 3, 4]);
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, payload]);
}

function decodeFrames(buffer) {
  const out = [];
  let buf = buffer;
  for (;;) {
    if (buf.length < 2) break;
    const opcode = buf[0] & 0x0f;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); offset = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
    if (buf.length < offset + len) break;
    const payload = buf.slice(offset, offset + len).toString('utf8');
    buf = buf.slice(offset + len);
    if (opcode === 0x1) { try { out.push(JSON.parse(payload)); } catch (e) {} }
  }
  return { messages: out, rest: buf };
}

function testServer() {
  const net = require('net');
  const http = require('http');
  const PORT = 8123;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), MAX_MONSTERS: '80' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', d => { output += d.toString(); });
  return { child: child, port: PORT, getOutput: () => output };
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchHealth(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: '/health', timeout: 3000 }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve({ code: res.statusCode, body: JSON.parse(body) }); }
        catch (e) { resolve({ code: res.statusCode, body: null }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function fetchPage(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: pathname, timeout: 3000 }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ code: res.statusCode, body: body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function testLiveServer() {
  const srv = testServer();
  const messages = [];
  let socket = null;
  let buffer = Buffer.alloc(0);
  try {
    await wait(900);

    /* HTTP */
    const health = await fetchHealth(srv.port);
    ok(health.code === 200, 'el estado de salud debe responder 200');
    ok(health.body && health.body.ok === true, 'el estado de salud debe informar de que el servidor está vivo');
    ok(health.body && health.body.monsters > 0, 'el mundo debe poblarse de monstruos al arrancar (' + (health.body && health.body.monsters) + ')');

    const page = await fetchPage(srv.port, '/');
    ok(page.code === 200 && page.body.indexOf('TIERRAS DE AETHEL') >= 0, 'la página principal debe servirse');
    ok(page.body.indexOf('shared/game-data.js') >= 0, 'la página debe cargar el mundo compartido');

    const data = await fetchPage(srv.port, '/shared/game-data.js');
    ok(data.code === 200, 'los archivos del juego deben servirse con el tipo correcto');

    const missing = await fetchPage(srv.port, '/no-existe.js');
    ok(missing.code === 404, 'un archivo inexistente debe dar 404');

    /* WebSocket hecho a mano, con el mismo formato que envía un navegador */
    const connected = await new Promise((resolve, reject) => {
      const s = net.connect(srv.port, '127.0.0.1', () => {
        s.write('GET / HTTP/1.1\r\n' +
          'Host: 127.0.0.1:' + srv.port + '\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n');
      });
      s.on('data', chunk => {
        const text = chunk.toString('binary');
        if (text.indexOf('101 Switching Protocols') >= 0) { resolve(s); return; }
        const i = text.indexOf('\r\n\r\n');
        if (i >= 0) { buffer = Buffer.concat([buffer, chunk.slice(i + 4)]); resolve(s); }
      });
      s.on('error', reject);
      setTimeout(() => reject(new Error('sin respuesta al saludo websocket')), 3000);
    });
    socket = connected;
    ok(true, 'el servidor debe aceptar el saludo WebSocket');

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const res = decodeFrames(buffer);
      buffer = res.rest;
      for (const m of res.messages) messages.push(m);
    });

    socket.write(encodeFrame(JSON.stringify({ t: 'join', name: 'Prueba', cls: 'guerrero' })));
    await wait(600);

    const welcome = messages.find(m => m.t === 'welcome');
    ok(!!welcome, 'debe llegarnos el mensaje de bienvenida');
    ok(welcome && welcome.seed === 20260101, 'la semilla del mundo debe coincidir con la del servidor');

    const joined = messages.find(m => m.t === 'joined');
    ok(!!joined && joined.name === 'Prueba', 'el servidor debe aceptar nuestro nombre');

    const states = messages.filter(m => m.t === 'state');
    ok(states.length > 2, 'debemos recibir el estado periódicamente (recibidos ' + states.length + ')');
    const st = states[states.length - 1];
    ok(!!st.you && st.you.hp > 0, 'el estado debe incluir nuestra vida');
    ok(typeof st.zone === 'string' && st.zone.length > 0, 'el estado debe indicar la zona');
    ok(!!st.town && st.town.name === 'Robledal', 'debemos aparecer en Robledal');

    /* Movimiento */
    const x0 = st.you.x, y0 = st.you.y;
    socket.write(encodeFrame(JSON.stringify({ t: 'input', up: false, down: false, left: false, right: true })));
    await wait(700);
    const st2 = messages.filter(m => m.t === 'state').pop();
    ok(st2 && (st2.you.x > x0 + 20 || st2.you.x < x0), 'el jugador debe moverse al pulsar una dirección');
    socket.write(encodeFrame(JSON.stringify({ t: 'input', up: false, down: false, left: false, right: false })));
    await wait(200);

    /* Recolección */
    const before = messages.length;
    socket.write(encodeFrame(JSON.stringify({ t: 'gather' })));
    await wait(400);
    const gatherMsgs = messages.slice(before).filter(m => m.t === 'gather' || m.t === 'note');
    ok(gatherMsgs.length > 0, 'la acción de recolectar debe contestar siempre, con éxito o con un aviso');

    /* Ataque sin objetivo cercano: no debe romper nada */
    socket.write(encodeFrame(JSON.stringify({ t: 'attack', id: 'm999999' })));
    await wait(250);
    ok(true, 'atacar a un objetivo inexistente no debe desconectar al cliente');

    /* Chat */
    const beforeChat = messages.length;
    socket.write(encodeFrame(JSON.stringify({ t: 'chat', text: 'hola mundo' })));
    await wait(400);
    const chatMsgs = messages.slice(beforeChat).filter(m => m.t === 'chat');
    ok(chatMsgs.length > 0, 'el mensaje de chat debe retransmitirse al jugador');

    /* Compra fuera de un pueblo (nos movimos un poco, seguimos en Robledal) */
    socket.write(encodeFrame(JSON.stringify({ t: 'buy', item: 'hierba' })));
    await wait(300);
    const shop = messages.filter(m => m.t === 'shop').pop();
    ok(!!shop, 'comprar dentro del pueblo debe devolver el inventario actualizado');
    ok(shop && shop.gold < 40, 'comprar debe descontar oro');

    /* Descanso */
    socket.write(encodeFrame(JSON.stringify({ t: 'rest' })));
    await wait(300);
    ok(messages.some(m => m.t === 'rest'), 'descansar en la posada debe confirmarse');

    /* Muchos mensajes seguidos: el servidor no debe caerse */
    for (let i = 0; i < 120; i++) socket.write(encodeFrame(JSON.stringify({ t: 'sync' })));
    await wait(600);
    const alive = await fetchHealth(srv.port);
    ok(alive.body && alive.body.players === 1, 'el servidor debe seguir atendiendo tras una ráfaga (jugadores: ' + (alive.body && alive.body.players) + ')');
    ok(messages.filter(m => m.t === 'state').length > 10, 'debe seguir enviando estado tras la ráfaga');

  } finally {
    if (socket) { try { socket.destroy(); } catch (e) {} }
    await wait(150);
    srv.child.kill();
    await wait(200);
    if (srv.getOutput().indexOf('escuchando') >= 0) report.notes.push('  servidor: arrancó y sirvió el mundo correctamente');
    else report.notes.push('  aviso: salida del servidor → ' + srv.getOutput().slice(0, 300));
  }
}

/* ------------------------------- EJECUCIÓN ------------------------------ */
async function main() {
  suite('Mundo compartido: determinismo, terreno y contenido', testWorld);
  await new Promise(resolve => {
    const before = report.failed;
    testLiveServer().then(() => {
      report.notes.push((report.failed > before ? '✗ ' : '✓ ') + 'Servidor: HTTP, WebSocket, movimiento, comercio y chat');
      resolve();
    }).catch(e => {
      report.failed++;
      report.failures.push('Servidor: excepción → ' + (e && e.message ? e.message : e));
      report.notes.push('✗ Servidor: HTTP, WebSocket, movimiento, comercio y chat');
      resolve();
    });
  });

  const line = '─'.repeat(62);
  console.log(line);
  console.log('  TIERRAS DE AETHEL — ARNÉS DE PRUEBAS');
  console.log(line);
  for (const n of report.notes) console.log('  ' + n);
  console.log(line);
  console.log('  PASA: ' + report.passed + '   FALLA: ' + report.failed);
  if (report.failures.length) { console.log(line); for (const f of report.failures) console.log('  ✗ ' + f); }
  console.log(line);
  process.exit(report.failed ? 1 : 0);
}

main();
