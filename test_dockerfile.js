"use strict";

/**
 * Comprueba que la imagen lleva TODOS los modulos que el codigo necesita.
 *
 * POR QUE EXISTE. El Dockerfile copia una lista explicita de archivos, no la
 * carpeta entera. Es correcto -no queremos meter node_modules, tests ni los
 * veinte apply_fixes*.js- pero es una trampa: cada modulo nuevo hay que
 * acordarse de anadirlo, y si no, el contenedor arranca y muere con
 * MODULE_NOT_FOUND. Paso de verdad al anadir pricing.js: el build salio bien, la
 * imagen se construyo bien, y el fallo solo aparecio al arrancar en produccion.
 *
 * Esta prueba recorre los require locales desde el punto de entrada y verifica
 * que cada archivo alcanzable este en el COPY. Se ejecuta en segundos y evita un
 * despliegue fallido.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const RAIZ = __dirname;
const ENTRADA = "server.js";

const dockerfile = fs.readFileSync(path.join(RAIZ, "Dockerfile"), "utf8");

// Los .js sueltos que el Dockerfile copia al directorio de trabajo.
const copiados = new Set();
for (const linea of dockerfile.split("\n")) {
  const limpia = linea.trim();
  if (!limpia.startsWith("COPY ")) continue;
  for (const trozo of limpia.slice(5).split(/\s+/)) {
    if (trozo.endsWith(".js")) copiados.add(trozo);
  }
}
assert.ok(copiados.size > 0, "el Dockerfile deberia copiar archivos .js");

/** Requires locales de un archivo: require("./algo"). */
function requiresLocales(archivo) {
  const codigo = fs.readFileSync(path.join(RAIZ, archivo), "utf8");
  const encontrados = new Set();
  const patron = /require\(\s*["'](\.\/[^"']+)["']\s*\)/g;
  let m;
  while ((m = patron.exec(codigo)) !== null) {
    let destino = m[1].replace(/^\.\//, "");
    // Solo se le pone .js a lo que no trae extension. Un require("./package.json")
    // es un require valido y no debe convertirse en "package.json.js".
    if (!path.extname(destino)) destino += ".js";
    // Solo interesan los modulos de codigo: un .json que falte da otro error, no
    // un MODULE_NOT_FOUND de arranque, y package.json sí lo copia el Dockerfile.
    if (destino.endsWith(".js")) encontrados.add(destino);
  }
  return [...encontrados];
}

// Recorrido desde el punto de entrada: no basta con mirar server.js, porque un
// modulo copiado puede requerir otro que no lo este.
const visitados = new Set();
const pendientes = [ENTRADA];
const faltan = [];

while (pendientes.length) {
  const actual = pendientes.pop();
  if (visitados.has(actual)) continue;
  visitados.add(actual);

  if (!fs.existsSync(path.join(RAIZ, actual))) {
    faltan.push(actual + " (no existe en el repositorio)");
    continue;
  }
  if (actual !== ENTRADA && !copiados.has(actual)) {
    faltan.push(actual + " (existe, pero el Dockerfile NO lo copia)");
  }
  for (const dep of requiresLocales(actual)) pendientes.push(dep);
}

assert.deepEqual(
  faltan,
  [],
  "El contenedor arrancaria y moriria con MODULE_NOT_FOUND por:\n  - " + faltan.join("\n  - ")
);

// Y al reves: que no se copien archivos que ya no existen.
for (const archivo of copiados) {
  assert.ok(
    fs.existsSync(path.join(RAIZ, archivo)),
    "el Dockerfile copia " + archivo + ", que ya no existe: el build fallaria"
  );
}

console.log("test_dockerfile: PASS (" + visitados.size + " modulos alcanzables, todos en la imagen)");

// --- Y QUE EL HEALTHCHECK PUEDA EJECUTARSE -----------------------------------
//
// COOLIFY COMPRUEBA LA SALUD PIDIENDO /health CON `curl` DESDE DENTRO DEL CONTENEDOR. En
// una imagen alpine curl no viene incluido, y entonces pasa lo peor que puede pasar con
// una comprobacion: no falla, MIENTE.
//
//     Healthcheck logs: /bin/sh: curl: not found | Return code: 0
//     New container is healthy.
//
// El comando no existe, devuelve codigo 0 -«todo bien»- y Coolify concluye «healthy» pase
// lo que pase. Si el Adapter se cuelga, nadie lo reinicia y nadie avisa: se descubre
// porque un paciente no recibe respuesta.
//
// ESTUVO ASI MESES Y SE VEIA EN CADA DESPLIEGUE, en esa misma linea del log. Nadie la
// leyo porque terminaba en «healthy».

{
  assert.ok(
    /apk add[^\n]*\bcurl\b/.test(dockerfile),
    "la imagen no instala curl: el healthcheck de Coolify dira «healthy» siempre, "
    + "aunque el Adapter este colgado"
  );

  // Y ANTES DEL COPY DEL CODIGO, para que un cambio de codigo no invalide esa capa y
  // reinstale paquetes en cada despliegue.
  assert.ok(
    dockerfile.indexOf("apk add") < dockerfile.indexOf("COPY server.js"),
    "instalar curl despues de copiar el codigo rehace esa capa en cada despliegue"
  );
}

console.log("test_dockerfile: el healthcheck puede ejecutarse OK");
