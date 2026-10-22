# Tierras de Aethel

MMO RPG cenital que se juega en el navegador. El mundo es un mapa continuo de 160 × 160 casillas que se recorre
a pie: praderas, bosques, ruinas, ceniza y nieve, con un río, un lago, tres pueblos amurallados por zonas seguras
y tres mazmorras con jefe propio. Los monstruos viven en el mundo, te ven llegar y te persiguen.

**El servidor es autoritativo.** Él mueve a los jugadores y a los monstruos, resuelve el daño y decide el botín.
El cliente solo dibuja, predice su propio movimiento e interpola lo que ve de los demás.

---

## Cómo jugar

```bash
node server/server.js
```

Y abre `http://localhost:8080`. Para jugar con alguien más, esa persona entra en la misma dirección.

No hay dependencias: solo Node 16 o superior. Para cambiar el puerto o la semilla del mundo:

```bash
PORT=3000 WORLD_SEED=42 node server/server.js
```

---

## Contenido

**Mundo abierto**

- Ocho regiones contiguas con cinco biomas: praderas, bosque umbrío, ruinas, picos de ceniza y altiplanicie helada.
- Un río que cruza el mapa y un lago, con casillas no transitables que obligan a rodear.
- Tres pueblos como zonas seguras, con mercader, posada y servicios distintos.
- Tres mazmorras con entrada visible desde el mapa y un jefe propio: el Guardián de Qarim, el Devorador de
  Ceniza y el Rey del Vacío.
- Recursos repartidos por bioma: árboles, hierba curativa y vetas de piedra rúnica.

**Monstruos**

- Doce criaturas repartidas por bioma más tres jefes, cada una con vida, ataque, defensa, velocidad, radio de
  detección y botín propios.
- Pasean en torno a su territorio, detectan al jugador dentro de su radio de agresión, lo persiguen y golpean
  por contacto con enfriamiento.
- El mundo se puebla solo: el servidor añade criaturas de forma continua hasta el tope configurado, y nunca
  aparecen a menos de 320 píxeles de un jugador.

**Progresión**

- Curva de experiencia por nivel, tres clases con vida y velocidad distintas (Guerrero, Maga, Pícara).
- Cuatro oficios que suben por separado: talar, minar, recolectar y combate, cada uno con su propio nivel.
- Veinticinco objetos: materiales, consumibles y equipo con ranuras de arma, armadura y accesorio.
- Tienda con compra, venta, equipo automático al comprar y posada que restablece la vida.

**Multijugador**

- Se ven todos los jugadores conectados, con su nombre, clase, nivel y barra de vida.
- Chat global en tiempo real.
- Los pueblos son zonas seguras: dentro no se recibe daño.

**Presentación**

- Motor de dibujo cenital en lienzo 2D, con cámara centrada en el jugador, temblor al recibir golpes,
  números de daño flotantes y partículas.
- El terreno se cachea por bloques de 16 casillas, así que mover la cámara cuesta muy poco.
- Minimapa permanente y mapa completo del mundo con pueblos, mazmorras y jugadores.
- Cada criatura se dibuja a mano según su especie, con sombra, orientación y aviso de alerta.

---

## Controles

| Tecla | Acción |
|---|---|
| `W` `A` `S` `D` o flechas | Moverse |
| `Espacio` | Atacar al monstruo más cercano |
| `F` | Recolectar el recurso más próximo |
| `E` | Entrar en la mazmorra o abrir la tienda |
| `G` | Mercader y posada |
| `I` | Inventario y oficios |
| `C` | Ficha de personaje |
| `M` | Mapa del mundo |
| `Enter` | Chat |
| `H` | Ayuda |
| `R` | Reaparecer tras caer |

---

## Estructura

```
shared/game-data.js   Mundo, monstruos, objetos, oficios y progresión (cliente y servidor)
server/server.js      Servidor autoritativo: WebSocket + archivos estáticos, sin dependencias
client/net.js         Conexión, predicción del jugador local e interpolación de los demás
client/main.js        Motor de dibujo cenital y minimapa
client/ui.js          Entrada, HUD, chat, inventario, tienda y mapa
index.html            Arranque del cliente
```

### El truco del mundo compartido

Cliente y servidor generan el mismo mapa sin intercambiar ni una casilla, porque todo el contenido sale de una
función de dispersión determinista sobre las coordenadas y la semilla:

```js
function hash2(x, y, salt) {
  let h = (x * 374761393 + y * 668265263 + (salt || 0) * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
```

El cliente pide el mapa a esa misma función al dibujar; el servidor la usa para decidir colisiones y apariciones.
Con la misma semilla, ambos ven el mismo mundo.

### Sincronización

El servidor manda estado cada 100 ms. Para que se sienta inmediato:

- **Predicción local:** tu personaje se mueve en cuanto pulsas, aplicando las mismas reglas de colisión que el
  servidor. Cuando llega el estado real, se corrige con un acercamiento suave y solo salta si la diferencia pasa
  de 90 píxeles.
- **Interpolación:** los demás jugadores y los monstruos se dibujan 140 ms en el pasado, interpolando entre los
  dos estados recibidos. Así el movimiento se ve continuo aunque lleguen diez paquetes por segundo.

---

## Pruebas

```bash
node tests/harness.js
```

El arnés hace dos cosas. Primero revisa el mundo: determinismo con la misma semilla, proporción de terreno
transitable, coherencia de pueblos, entradas y jefes, y que toda referencia entre monstruos, objetos y biomas
apunte a algo que existe. Después **arranca el servidor de verdad** y le habla con un cliente WebSocket escrito
a mano: comprueba el saludo, la bienvenida con la semilla, la recepción periódica de estado, el movimiento, la
recolección, el comercio, el descanso, el chat y que una ráfaga de 120 mensajes seguidos no lo tumbe.

---

## Estado del proyecto

El mundo compartido y el servidor están cubiertos por el arnés, que los ejecuta de verdad al comprobarse.
La interfaz del navegador sigue el protocolo que ese arnés prueba, pero **no se ha ejecutado en un navegador real
desde este entorno**: si algo se ve raro al abrirlo, es ahí donde habrá que mirar.

## Licencia

MIT.
