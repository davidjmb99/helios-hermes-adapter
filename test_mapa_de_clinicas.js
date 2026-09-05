"use strict";

/**
 * El mapa de clinicas del Adapter, leido de la tabla.
 *
 * POR QUE EL ADAPTER TAMBIEN. `validateTenantContext` compara lo que manda el Gateway
 * contra el mapa de ESTE proceso, y rechaza el mensaje si no cuadran. Esa comprobacion
 * solo protege mientras las dos partes miren lo mismo.
 *
 * Hasta hoy miraban dos copias a mano de la misma variable de entorno, una en cada
 * servicio de Coolify. Si el Gateway pasa a leer la tabla y el Adapter se queda en la
 * variable, la comprobacion deja de proteger y empieza a RECHAZAR MENSAJES BUENOS — y el
 * sintoma, TENANT_CONTEXT_MISMATCH, no se parece en nada a la causa.
 *
 * Por eso la seccion 3 es la que de verdad importa aqui: que lo que el Gateway construye
 * desde la tabla lo acepte el Adapter leyendo la misma tabla.
 */

const assert = require("assert");

process.env.CHATWOOT_TENANT_CONTEXTS_JSON = JSON.stringify({
  // Perfiles marcados para poder distinguir CUAL de las dos fuentes contesto. Si los dos
  // mapas dijeran lo mismo, la prueba pasaria aunque la tabla no se leyera nunca.
  "2": { tenant_id: "democoi1", clinic_id: "coi", hermes_profile: "helios-por-entorno" }
});

const ctx = require("./tenant-context");

/** Una base que devuelve estas filas. Es todo lo que el refresco le pide. */
function baseCon(filas) {
  return { from: () => ({ select: async () => ({ data: filas, error: null }) }) };
}

const DOS_CLINICAS = [
  { tenant_id: "democoi1", account_id: "2", clinic_id: "coi", hermes_profile: "helios", mapa_activo: true },
  { tenant_id: "pruebawh1", account_id: "3", clinic_id: "prueba", hermes_profile: "helios-prueba-wh", mapa_activo: true }
];

const warnDeVerdad = console.warn;
const avisos = [];
console.warn = (...args) => { avisos.push(String(args[0])); };

// ---------------------------------------------------------------------------
// 1. SIN TABLA, TODO SIGUE COMO ESTABA
// ---------------------------------------------------------------------------

ctx.reiniciarMapaParaPruebas();

// ANTES DE QUE NADIE LEA NADA. El mapa del entorno se carga perezosamente, asi que recien
// arrancado el proceso no hay nada en memoria. Si `estadoDelMapa` no forzara la carga,
// /health diria «0 clinicas» en un sistema sano mientras no llegara un mensaje — y eso se
// mira JUSTO al desplegar, que es cuando todavia no ha escrito nadie.
assert.strictEqual(ctx.estadoDelMapa().clinicas, 1,
  "/health tiene que contar las clinicas aunque no haya llegado ningun mensaje");

assert.strictEqual(ctx.resolveTenantContext("2").hermes_profile, "helios-por-entorno");
assert.strictEqual(ctx.estadoDelMapa().fuente, "entorno");

// Y CON LA VARIABLE ROTA NO PUEDE LANZAR: /health es lo que se mira cuando algo va mal.
{
  const anterior = process.env.CHATWOOT_TENANT_CONTEXTS_JSON;
  ctx.reiniciarMapaParaPruebas();
  process.env.CHATWOOT_TENANT_CONTEXTS_JSON = "{ esto no es JSON";
  assert.strictEqual(ctx.estadoDelMapa().clinicas, 0,
    "sin mapa, el recuento lo dice en vez de reventar");
  process.env.CHATWOOT_TENANT_CONTEXTS_JSON = anterior;
  ctx.reiniciarMapaParaPruebas();
}

// ---------------------------------------------------------------------------
// 2. CON TABLA, MANDA LA TABLA
// ---------------------------------------------------------------------------

ctx.reiniciarMapaParaPruebas();
ctx.__setSupabaseClientForTests(baseCon(DOS_CLINICAS));

(async () => {
  await ctx.refrescarMapaDesdeTabla();

  assert.strictEqual(ctx.estadoDelMapa().fuente, "tabla");
  assert.strictEqual(ctx.estadoDelMapa().clinicas, 2);
  assert.strictEqual(ctx.resolveTenantContext("2").hermes_profile, "helios");

  // -------------------------------------------------------------------------
  // 3. LO QUE VIENE DE LA TABLA SE ACEPTA; LO QUE NO, SE RECHAZA
  // -------------------------------------------------------------------------
  //
  // Esta es la razon de ser del fichero. El Gateway construye el payload desde la tabla;
  // el Adapter tiene que reconocerlo leyendo la misma tabla.

  const comoLoMandaElGateway = {
    account_id: "2", tenant_id: "democoi1", clinic_id: "coi", hermes_profile: "helios"
  };
  assert.strictEqual(ctx.validateTenantContext(comoLoMandaElGateway).clinic_id, "coi");

  // Y LA PROTECCION SIGUE VIVA. Un payload que dice el perfil de otra clinica se rechaza:
  // sin esto, un mensaje de COI podria acabar hablando con el Hermes de la clinica 3.
  assert.throws(
    () => ctx.validateTenantContext({ ...comoLoMandaElGateway, hermes_profile: "helios-prueba-wh" }),
    (e) => e.code === "TENANT_CONTEXT_MISMATCH",
    "un perfil que no es el de esa cuenta tiene que rechazarse"
  );
  assert.throws(
    () => ctx.validateTenantContext({ ...comoLoMandaElGateway, tenant_id: "pruebawh1" }),
    (e) => e.code === "TENANT_CONTEXT_MISMATCH",
    "un tenant_id que no es el de esa cuenta tampoco"
  );

  // ESTE ES EL FALLO QUE SE ESTA EVITANDO. Antes de este cambio, el Gateway leyendo la
  // tabla y el Adapter la variable daban esto: un payload correcto, rechazado.
  assert.throws(
    () => ctx.validateTenantContext({ ...comoLoMandaElGateway, hermes_profile: "helios-por-entorno" }),
    (e) => e.code === "TENANT_CONTEXT_MISMATCH",
    "el valor viejo de la variable ya no vale: por eso los dos tienen que leer la tabla"
  );

  // -------------------------------------------------------------------------
  // 4. LA BASE CAIDA NO SE LLEVA EL MAPA
  // -------------------------------------------------------------------------

  ctx.__setSupabaseClientForTests({ from() { throw new Error("ECONNREFUSED"); } });
  await ctx.refrescarMapaDesdeTabla();
  assert.strictEqual(ctx.resolveTenantContext("2").hermes_profile, "helios",
    "con la base caida se sigue atendiendo con el ultimo mapa bueno");

  // Y el error DEVUELTO, no lanzado, que es el caso de unos permisos mal puestos.
  ctx.__setSupabaseClientForTests({
    from: () => ({ select: async () => ({ data: null, error: { message: "permission denied" } }) })
  });
  await ctx.refrescarMapaDesdeTabla();
  assert.strictEqual(ctx.estadoDelMapa().clinicas, 2);

  // -------------------------------------------------------------------------
  // 5. UNA TABLA VACIA TAMPOCO LO BORRA
  // -------------------------------------------------------------------------
  //
  // Cero filas y un fallo de lectura se parecen demasiado como para tratar cero como
  // «ya no hay clinicas».

  ctx.__setSupabaseClientForTests(baseCon([]));
  await ctx.refrescarMapaDesdeTabla();
  assert.strictEqual(ctx.estadoDelMapa().clinicas, 2, "cero filas NO puede vaciar el mapa");

  // -------------------------------------------------------------------------
  // 6. UNA FILA A MEDIAS SOLO SE LLEVA A SU CLINICA
  // -------------------------------------------------------------------------

  ctx.reiniciarMapaParaPruebas();
  ctx.__setSupabaseClientForTests(baseCon([
    DOS_CLINICAS[0],
    { tenant_id: "pruebawh1", account_id: "3", clinic_id: "prueba", hermes_profile: null, mapa_activo: true }
  ]));
  await ctx.refrescarMapaDesdeTabla();

  assert.strictEqual(ctx.resolveTenantContext("2").clinic_id, "coi", "la sana sigue atendiendose");
  assert.throws(() => ctx.resolveTenantContext("3"), (e) => e.code === "TENANT_NOT_CONFIGURED",
    "sin perfil no se sabe a que Hermes hablarle: mejor no atender que atender mal");

  // -------------------------------------------------------------------------
  // 7. LA LECTURA SIGUE SIENDO SINCRONA
  // -------------------------------------------------------------------------
  //
  // `validateTenantContext` la llama sin await. Si devolviera una promesa, sus tres
  // comparaciones darian `undefined !== "coi"` y RECHAZARIA TODO, sin lanzar nada raro.

  const r = ctx.resolveTenantContext("2");
  assert.ok(!(r instanceof Promise), "resolveTenantContext no puede devolver una promesa");
  assert.strictEqual(typeof r.then, "undefined");

  const fuente = require("fs").readFileSync(require("path").join(__dirname, "tenant-context.js"), "utf8");
  assert.ok(!/async function resolveTenantContext/.test(fuente),
    "resolveTenantContext tiene que seguir siendo sincrona");
  assert.ok(!/async function validateTenantContext/.test(fuente),
    "validateTenantContext tambien: server.js la llama sin await");

  // -------------------------------------------------------------------------
  // 8. EL TEMPORIZADOR NO PUEDE DEJAR EL PROCESO COLGADO
  // -------------------------------------------------------------------------

  ctx.arrancarRefrescoDelMapa(60000);
  ctx.arrancarRefrescoDelMapa(60000);
  ctx.pararRefrescoDelMapa();

  console.warn = warnDeVerdad;
  console.log("test_mapa_de_clinicas: OK");
})().catch((e) => {
  console.warn = warnDeVerdad;
  console.error(e);
  process.exit(1);
});
