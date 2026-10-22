/* =========================================================================
   TIERRAS DE AETHEL — Motor de dibujo cenital

   Todo se pinta en un lienzo 2D con la cámara centrada en el jugador. El
   terreno se cachea por bloques de 16 casillas, así que el coste por fotograma
   es dibujar unos pocos lienzos y encima las entidades.
   ========================================================================= */
(function (root) {
'use strict';

const Sh = root.AethelShared;
const TILE = Sh.TILE;

const Render = {
  canvas: null, ctx: null, w: 0, h: 0, dpr: 1,
  chunkCache: new Map(),
  CHUNK: 16,
  camX: 0, camY: 0,
  floats: [],
  puffs: [],
  shake: 0,

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
  },

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(320, Math.round(rect.width));
    this.h = Math.max(240, Math.round(rect.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  },

  chunkFor(cx, cy) {
    const key = cx + ',' + cy;
    const cached = this.chunkCache.get(key);
    if (cached) return cached;
    const size = this.CHUNK * TILE;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const g = c.getContext('2d');
    const ox = cx * this.CHUNK, oy = cy * this.CHUNK;
    for (let x = 0; x < this.CHUNK; x++) {
      for (let y = 0; y < this.CHUNK; y++) {
        const wx = ox + x, wy = oy + y;
        const t = Sh.terrainAt(wx, wy);
        const def = Sh.TERRAIN[t];
        g.fillStyle = def.color;
        g.fillRect(x * TILE, y * TILE, TILE, TILE);
        const n = Sh.RNG.hash2(wx, wy, 5);
        g.fillStyle = 'rgba(0,0,0,' + (n * 0.16).toFixed(3) + ')';
        g.fillRect(x * TILE, y * TILE, TILE, TILE);
        if (def.walk && !Sh.walkable(wx, wy + 1)) {
          g.fillStyle = 'rgba(255,255,255,.10)';
          g.fillRect(x * TILE, y * TILE + TILE - 4, TILE, 4);
        }
        if (t === 'water') {
          const wv = Sh.RNG.hash2(wx, wy, 9);
          g.fillStyle = 'rgba(255,255,255,' + (0.04 + wv * 0.05).toFixed(3) + ')';
          g.fillRect(x * TILE + (wv * 14 | 0), y * TILE + (n * 20 | 0), 16, 3);
        }
      }
    }
    this.chunkCache.set(key, c);
    if (this.chunkCache.size > 260) {
      const first = this.chunkCache.keys().next().value;
      this.chunkCache.delete(first);
    }
    return c;
  },

  drawTerrain(g, camX, camY) {
    const cs = this.CHUNK * TILE;
    const c0x = Math.floor(camX / cs) - 1;
    const c0y = Math.floor(camY / cs) - 1;
    const cols = Math.ceil(this.w / cs) + 2;
    const rows = Math.ceil(this.h / cs) + 2;
    for (let cx = c0x; cx < c0x + cols; cx++) {
      for (let cy = c0y; cy < c0y + rows; cy++) {
        if (cx < 0 || cy < 0) continue;
        if (cx * this.CHUNK >= Sh.MAP_W || cy * this.CHUNK >= Sh.MAP_H) continue;
        g.drawImage(this.chunkFor(cx, cy), Math.round(cx * cs - camX), Math.round(cy * cs - camY));
      }
    }
  },

  drawTowns(g, camX, camY) {
    for (let i = 0; i < Sh.world.towns.length; i++) {
      const t = Sh.world.towns[i];
      const px = t.x * TILE - camX, py = t.y * TILE - camY;
      const r = t.r * TILE;
      if (px < -r - 240 || py < -r - 240 || px > this.w + r + 240 || py > this.h + r + 240) continue;
      g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2);
      g.fillStyle = 'rgba(120,96,64,.28)'; g.fill();
      g.strokeStyle = 'rgba(226,196,140,.35)'; g.lineWidth = 3;
      g.setLineDash([10, 8]); g.stroke(); g.setLineDash([]);
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        const hx = px + Math.cos(a) * r * 0.55;
        const hy = py + Math.sin(a) * r * 0.55;
        g.save(); g.translate(hx, hy);
        g.fillStyle = '#4a3b2e'; g.fillRect(-16, -14, 32, 28);
        g.fillStyle = '#7c3f3f';
        g.beginPath(); g.moveTo(-20, -14); g.lineTo(0, -30); g.lineTo(20, -14); g.closePath(); g.fill();
        g.fillStyle = 'rgba(255,214,140,.55)'; g.fillRect(-5, -4, 10, 10);
        g.restore();
      }
      g.font = 'bold 15px ui-monospace,monospace';
      g.textAlign = 'center';
      g.fillStyle = 'rgba(0,0,0,.55)'; g.fillText(t.name, px + 1, py - r + 9);
      g.fillStyle = '#ffe9a8'; g.fillText(t.name, px, py - r + 8);
      g.font = '11px ui-monospace,monospace';
      g.fillStyle = 'rgba(255,233,168,.7)'; g.fillText('zona segura', px, py - r + 24);
    }
  },

  drawDungeonDoors(g, camX, camY, near) {
    for (let i = 0; i < Sh.world.dungeons.length; i++) {
      const d = Sh.world.dungeons[i];
      const px = d.x * TILE - camX, py = d.y * TILE - camY;
      const isNear = near && near.id === d.id;
      g.save(); g.translate(px, py);
      g.fillStyle = '#1a1420';
      g.beginPath(); g.ellipse(0, 0, 30, 20, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#7b5ad8'; g.lineWidth = 3; g.stroke();
      g.fillStyle = 'rgba(123,90,216,.35)';
      g.beginPath(); g.ellipse(0, 4, 20, 12, 0, 0, Math.PI * 2); g.fill();
      g.restore();
      g.font = 'bold 12px ui-monospace,monospace';
      g.textAlign = 'center';
      g.fillStyle = '#c8a8ff'; g.fillText(d.name, px, py - 30);
      g.font = '10px ui-monospace,monospace';
      g.fillStyle = 'rgba(200,168,255,.75)'; g.fillText('nivel ' + d.level, px, py - 16);
      if (isNear) {
        g.fillStyle = '#ffe9a8'; g.font = 'bold 12px ui-monospace,monospace';
        g.fillText('E para entrar', px, py + 40);
      }
    }
  },

  drawNodes(g, camX, camY) {
    const x0 = Math.floor(camX / TILE) - 1, y0 = Math.floor(camY / TILE) - 1;
    const x1 = x0 + Math.ceil(this.w / TILE) + 2, y1 = y0 + Math.ceil(this.h / TILE) + 2;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const n = Sh.nodeAt(x, y);
        if (!n) continue;
        const px = n.x - camX, py = n.y - camY;
        const def = Sh.NODES[n.type];
        if (n.type === 'arbol') {
          g.fillStyle = 'rgba(0,0,0,.28)';
          g.beginPath(); g.ellipse(px, py + 10, 15, 7, 0, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#3a2a1c'; g.fillRect(px - 3, py - 2, 6, 14);
          g.fillStyle = def.color;
          g.beginPath(); g.arc(px, py - 10, 15, 0, Math.PI * 2); g.fill();
          g.fillStyle = 'rgba(255,255,255,.08)';
          g.beginPath(); g.arc(px - 5, py - 14, 7, 0, Math.PI * 2); g.fill();
        } else if (n.type === 'piedra') {
          g.fillStyle = 'rgba(0,0,0,.28)';
          g.beginPath(); g.ellipse(px, py + 9, 14, 6, 0, 0, Math.PI * 2); g.fill();
          g.fillStyle = def.color;
          g.beginPath();
          g.moveTo(px - 13, py + 8); g.lineTo(px - 5, py - 12); g.lineTo(px + 8, py - 10); g.lineTo(px + 14, py + 8);
          g.closePath(); g.fill();
          g.strokeStyle = 'rgba(180,200,255,.25)'; g.lineWidth = 1.5; g.stroke();
        } else {
          g.fillStyle = def.color;
          for (let i = 0; i < 3; i++) {
            const a = i * 2.1;
            g.beginPath(); g.ellipse(px + Math.cos(a) * 5, py + Math.sin(a) * 3, 4, 6, a, 0, Math.PI * 2); g.fill();
          }
        }
      }
    }
  },

  drawMonster(g, m, camX, camY, now) {
    const px = m.x - camX, py = m.y - camY;
    if (px < -140 || py < -140 || px > this.w + 140 || py > this.h + 140) return;
    const bob = Math.sin((now / 260) + m.x * 0.01) * 2;
    const s = m.r / 14;
    const alert = m.state === 'chase';
    g.save();
    g.translate(px, py + bob);
    g.fillStyle = 'rgba(0,0,0,.32)';
    g.beginPath(); g.ellipse(0, m.r * 0.75, m.r * 0.9, m.r * 0.4, 0, 0, Math.PI * 2); g.fill();
    g.save();
    g.scale(Math.cos(m.dir) < 0 ? -1 : 1, 1);
    g.fillStyle = m.color;
    g.strokeStyle = 'rgba(0,0,0,.5)';
    g.lineWidth = 2;
    switch (m.art) {
      case 'lobo':
        g.beginPath(); g.ellipse(0, 0, 15 * s, 10 * s, 0, 0, Math.PI * 2); g.fill(); g.stroke();
        g.beginPath(); g.moveTo(12 * s, -4 * s); g.lineTo(22 * s, 0); g.lineTo(12 * s, 5 * s); g.closePath(); g.fill(); g.stroke();
        g.fillStyle = '#ffdf6b';
        g.beginPath(); g.arc(8 * s, -3 * s, 1.8 * s, 0, Math.PI * 2); g.fill();
        break;
      case 'jabali':
        g.beginPath(); g.ellipse(0, 0, 16 * s, 12 * s, 0, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = '#e8e8e8';
        g.beginPath(); g.moveTo(14 * s, 2 * s); g.lineTo(22 * s, -2 * s); g.lineTo(14 * s, -1 * s); g.closePath(); g.fill();
        break;
      case 'arania':
        g.beginPath(); g.arc(0, 0, 9 * s, 0, Math.PI * 2); g.fill(); g.stroke();
        g.strokeStyle = m.color; g.lineWidth = 2.5;
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI - 0.6;
          g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * 18 * s, Math.sin(a) * 14 * s); g.stroke();
          g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a + Math.PI) * 18 * s, Math.sin(a + Math.PI) * 14 * s); g.stroke();
        }
        g.fillStyle = '#ff5a5a';
        g.beginPath(); g.arc(4 * s, -3 * s, 1.6 * s, 0, Math.PI * 2); g.fill();
        break;
      case 'esqueleto':
      case 'humano':
        g.beginPath(); g.arc(0, -12 * s, 7 * s, 0, Math.PI * 2); g.fill(); g.stroke();
        g.beginPath(); g.moveTo(-6 * s, -4 * s); g.lineTo(6 * s, -4 * s); g.lineTo(4 * s, 12 * s); g.lineTo(-4 * s, 12 * s); g.closePath(); g.fill(); g.stroke();
        break;
      case 'golem':
      case 'ent':
        g.beginPath(); g.rect(-14 * s, -18 * s, 28 * s, 34 * s); g.fill(); g.stroke();
        g.fillStyle = '#8fe08f';
        g.beginPath(); g.arc(-5 * s, -8 * s, 2.4 * s, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(5 * s, -8 * s, 2.4 * s, 0, Math.PI * 2); g.fill();
        break;
      case 'mago':
        g.beginPath(); g.moveTo(0, -22 * s); g.lineTo(13 * s, 16 * s); g.lineTo(-13 * s, 16 * s); g.closePath(); g.fill(); g.stroke();
        g.fillStyle = '#e6d9ff';
        g.beginPath(); g.arc(0, 4 * s, 2 * s, 0, Math.PI * 2); g.fill();
        break;
      case 'troll':
        g.beginPath(); g.ellipse(0, 0, 18 * s, 20 * s, 0, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = '#fff';
        g.beginPath(); g.moveTo(-6 * s, 8 * s); g.lineTo(-3 * s, 16 * s); g.lineTo(-1 * s, 8 * s); g.closePath(); g.fill();
        break;
      case 'dragon':
        g.beginPath(); g.ellipse(0, 0, 18 * s, 13 * s, 0, 0, Math.PI * 2); g.fill(); g.stroke();
        g.beginPath(); g.moveTo(-6 * s, -8 * s); g.lineTo(-22 * s, -20 * s); g.lineTo(-10 * s, -2 * s); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(6 * s, -8 * s); g.lineTo(20 * s, -22 * s); g.lineTo(10 * s, -2 * s); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(16 * s, -2 * s); g.lineTo(28 * s, 2 * s); g.lineTo(16 * s, 6 * s); g.closePath(); g.fill();
        break;
      case 'espectro':
        g.globalAlpha = 0.82;
        g.beginPath(); g.arc(0, -6 * s, 12 * s, Math.PI, 0);
        g.lineTo(12 * s, 14 * s); g.lineTo(6 * s, 8 * s); g.lineTo(0, 14 * s); g.lineTo(-6 * s, 8 * s); g.lineTo(-12 * s, 14 * s);
        g.closePath(); g.fill();
        g.globalAlpha = 1;
        break;
      default:
        g.beginPath(); g.arc(0, 0, m.r, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    g.restore();

    g.font = '11px ui-monospace,monospace';
    g.textAlign = 'center';
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillText(m.name, 1, -m.r - 16);
    g.fillStyle = m.boss ? '#ffd166' : (alert ? '#ff9f9f' : '#dfe6f2');
    g.fillText(m.name, 0, -m.r - 17);
    const hpw = Math.max(26, m.r * 2.2);
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(-hpw / 2, -m.r - 12, hpw, 5);
    g.fillStyle = m.boss ? '#ffd166' : '#ff5470';
    g.fillRect(-hpw / 2, -m.r - 12, hpw * Math.max(0, m.hp / m.maxHp), 5);
    if (alert) {
      g.fillStyle = '#ff5470';
      g.font = 'bold 14px ui-monospace,monospace';
      g.fillText('!', 0, -m.r - 24 + Math.sin(now / 150) * 2);
    }
    if (m.boss) {
      g.fillStyle = '#ffd166';
      g.font = 'bold 12px ui-monospace,monospace';
      g.fillText('JEFE · nv ' + m.level, 0, m.r + 22);
    }
    g.restore();
  },

  drawPlayer(g, p, camX, camY, isSelf, now) {
    const px = p.x - camX, py = p.y - camY;
    if (px < -80 || py < -80 || px > this.w + 80 || py > this.h + 80) return;
    const bob = Math.sin((now / 220) + p.x * 0.02) * 1.5;
    const cls = p.cls || 'guerrero';
    const col = cls === 'mago' ? '#8f7bd8' : (cls === 'picaro' ? '#5ad8a0' : '#e07a5a');
    g.save();
    g.translate(px, py + bob);
    g.fillStyle = 'rgba(0,0,0,.34)';
    g.beginPath(); g.ellipse(0, 14, 12, 5, 0, 0, Math.PI * 2); g.fill();
    g.save();
    g.scale(Math.cos(p.dir || 0) < 0 ? -1 : 1, 1);
    g.fillStyle = col;
    g.strokeStyle = 'rgba(0,0,0,.55)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-9, 12); g.lineTo(-7, -6); g.lineTo(7, -6); g.lineTo(9, 12);
    g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#f0d0b0';
    g.beginPath(); g.arc(0, -12, 8, 0, Math.PI * 2); g.fill(); g.stroke();
    if (cls === 'mago') {
      g.fillStyle = '#5b4a9c';
      g.beginPath(); g.moveTo(0, -30); g.lineTo(11, -12); g.lineTo(-11, -12); g.closePath(); g.fill();
    } else if (cls === 'picaro') {
      g.fillStyle = '#2f6b52';
      g.beginPath(); g.arc(0, -15, 8.5, Math.PI, 0); g.fill();
    } else {
      g.fillStyle = '#a05a3a';
      g.beginPath(); g.arc(0, -15, 8.5, Math.PI, 0); g.fill();
    }
    g.fillStyle = '#22202a';
    g.beginPath(); g.arc(3, -12, 1.5, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#d8d8e8'; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(8, 0); g.lineTo(16, -8); g.stroke();
    g.restore();
    if (isSelf) {
      g.strokeStyle = 'rgba(255,233,168,.9)'; g.lineWidth = 2;
      g.beginPath(); g.ellipse(0, 8, 17, 9, 0, 0, Math.PI * 2); g.stroke();
    }
    g.font = (isSelf ? 'bold ' : '') + '11px ui-monospace,monospace';
    g.textAlign = 'center';
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillText(p.name + ' · nv' + p.level, 1, -27);
    g.fillStyle = isSelf ? '#ffe9a8' : '#cfe0ff';
    g.fillText(p.name + ' · nv' + p.level, 0, -28);
    if (!isSelf) {
      const bw = 40;
      g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(-bw / 2, -22, bw, 4);
      g.fillStyle = '#7bffb2';
      g.fillRect(-bw / 2, -22, bw * Math.max(0, Math.min(1, p.hp / (p.maxHp || 1))), 4);
    }
    g.restore();
  },

  addFloat(x, y, text, color) {
    this.floats.push({ x: x, y: y, text: text, color: color || '#fff', life: 1.1, max: 1.1 });
  },
  addPuff(x, y, color, n) {
    for (let i = 0; i < (n || 6); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 30 + Math.random() * 70;
      this.puffs.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5, max: 0.5, color: color || '#fff' });
    }
  },
  updateEffects(dt) {
    for (const f of this.floats) { f.y -= 26 * dt; f.life -= dt; }
    this.floats = this.floats.filter(f => f.life > 0);
    for (const p of this.puffs) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
    this.puffs = this.puffs.filter(p => p.life > 0);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 3);
  },
  drawEffects(g, camX, camY) {
    for (const p of this.puffs) {
      const t = p.life / p.max;
      g.globalAlpha = t;
      g.fillStyle = p.color;
      g.beginPath(); g.arc(p.x - camX, p.y - camY, 2.5 * t + 1, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
    g.textAlign = 'center';
    for (const f of this.floats) {
      const t = Math.max(0, f.life / f.max);
      g.globalAlpha = Math.min(1, t * 1.6);
      g.font = 'bold 15px ui-monospace,monospace';
      g.fillStyle = 'rgba(0,0,0,.65)'; g.fillText(f.text, f.x - camX + 1, f.y - camY + 1);
      g.fillStyle = f.color; g.fillText(f.text, f.x - camX, f.y - camY);
    }
    g.globalAlpha = 1;
  },

  clearCache() { this.chunkCache.clear(); },

  drawMinimap(g, self, players, mmW, mmH) {
    const px = 12, py = 12;
    const sx = mmW / (Sh.MAP_W * TILE), sy = mmH / (Sh.MAP_H * TILE);
    g.save();
    g.fillStyle = 'rgba(6,5,12,.85)';
    g.fillRect(px, py, mmW, mmH);
    const step = 4;
    for (let x = 0; x < Sh.MAP_W; x += step) {
      for (let y = 0; y < Sh.MAP_H; y += step) {
        g.fillStyle = Sh.TERRAIN[Sh.terrainAt(x, y)].color;
        g.fillRect(px + x * TILE * sx, py + y * TILE * sy, step * TILE * sx + 0.6, step * TILE * sy + 0.6);
      }
    }
    for (let i = 0; i < Sh.world.towns.length; i++) {
      const t = Sh.world.towns[i];
      g.fillStyle = '#ffe9a8';
      g.fillRect(px + t.x * TILE * sx - 2, py + t.y * TILE * sy - 2, 5, 5);
    }
    for (let i = 0; i < Sh.world.dungeons.length; i++) {
      const d = Sh.world.dungeons[i];
      g.fillStyle = '#c8a8ff';
      g.fillRect(px + d.x * TILE * sx - 2, py + d.y * TILE * sy - 2, 4, 4);
    }
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      g.fillStyle = '#7fd0ff';
      g.fillRect(px + p.x * sx - 1.5, py + p.y * sy - 1.5, 3, 3);
    }
    g.fillStyle = '#ffe9a8';
    g.fillRect(px + self.x * sx - 2.5, py + self.y * sy - 2.5, 5, 5);
    g.strokeStyle = 'rgba(160,140,220,.55)';
    g.lineWidth = 1;
    g.strokeRect(px + 0.5, py + 0.5, mmW - 1, mmH - 1);
    g.restore();
  }
};

root.AethelRender = Render;
})(typeof globalThis !== 'undefined' ? globalThis : this);
