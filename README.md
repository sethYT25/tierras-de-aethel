# Tierras de Aethel

MMO RPG cenital en el navegador. El mundo es un mapa continuo de 160 × 160 casillas que se recorre a pie:
praderas, bosques, ruinas, ceniza y nieve, con un río, un lago, tres pueblos y tres mazmorras. Los monstruos
viven en el mundo y te ven llegar.

El servidor es autoritativo: él mueve a los jugadores y a los monstruos, resuelve el daño y decide el botín.
El cliente solo dibuja, interpola y envía intenciones.

## Estructura

```
shared/game-data.js   Mundo, monstruos, objetos y progresión (cliente y servidor)
server/server.js      Servidor por WebSocket + servidor de archivos estáticos
client/main.js        Motor de dibujo cenital
client/net.js         Conexión, predicción local e interpolación
client/ui.js          Interfaz, entrada y chat
index.html            Arranque del cliente
```

Todo el contenido se deriva de la semilla del mundo con una función de dispersión determinista, así que
cliente y servidor generan el mismo mapa sin enviarse una sola casilla.
