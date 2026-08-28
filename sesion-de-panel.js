/**
 * Quien entra al panel del adapter, y que cuentas puede ver.
 *
 * ANTES ERA UNA CONTRASEÑA DE ENTORNO Y PUNTO: quien la tuviera veia todas las clinicas.
 * Valia mientras el adapter fuera solo del equipo tecnico. En cuanto entra una clinica con
 * su usuario, ver «todas» deja de ser comodidad y pasa a ser una fuga: en esas trazas van
 * los mensajes de los pacientes.
 *
 * ASI QUE LA CUENTA DEJA DE SER UN FILTRO DE VISTA Y PASA A SER UN PERMISO, igual que en el
 * gateway. Y la regla es la misma, regla 111:
 *
 *     LA CLINICA SALE DEL TOKEN. El parametro `?cuenta=` solo lo puede usar un operador,
 *     y a una clinica se le ignora aunque lo mande.
 *
 * Es importante que se ignore y no que de error: si diera error, probar `?cuenta=lapaz`
 * desde la cuenta de COI diria «esa clinica existe». Ignorarlo no dice nada.
 *
 * NO SE QUITA LA CONTRASEÑA DE ENTORNO. Sigue valiendo, y a proposito: si la tabla de
 * clinicas no responde -Supabase caido, una migracion a medias- el equipo tecnico tiene que
 * poder entrar a mirar por que. Una puerta de servicio que solo conoce quien tiene las
 * variables de Coolify.
 */

const crypto = require("crypto");

/** Ocho horas, como el panel del gateway. */
const DURACION_MS = 8 * 60 * 60 * 1000;

/** Marca de que es el token, para que no se confunda con el de la agenda ni con otro. */
const TIPO = "panel-v1";

function firmar(cuerpo, secreto) {
  return crypto.createHmac("sha256", secreto).update(cuerpo).digest("base64url");
}

/**
 * El token de una sesion.
 *
 * `operador` es lo que decide si puede mirar otras cuentas. Va DENTRO del token y firmado:
 * si viajara aparte, cualquiera se ascenderia a operador editando una cookie.
 */
function crearSesion({ tenantId, operador, secreto, ahora = Date.now() }) {
  const cuerpo = Buffer.from(JSON.stringify({
    t: TIPO,
    tenant_id: String(tenantId || ""),
    operador: operador === true,
    exp: ahora + DURACION_MS
  })).toString("base64url");
  return `${cuerpo}.${firmar(cuerpo, secreto)}`;
}

/**
 * Quien es, o null si el token no vale.
 *
 * LA COMPARACION ES EN TIEMPO CONSTANTE. Un `===` sobre la firma tarda un poco mas cuantos
 * mas caracteres coincidan desde el principio, y eso deja adivinarla midiendo respuestas.
 * Aqui el premio son las trazas de todas las clinicas.
 */
function leerSesion(token, secreto, ahora = Date.now()) {
  const bruto = String(token || "").trim();
  if (!bruto || !secreto) return null;

  const corte = bruto.lastIndexOf(".");
  if (corte <= 0) return null;
  const cuerpo = bruto.slice(0, corte);
  const firma = bruto.slice(corte + 1);

  const esperada = Buffer.from(firmar(cuerpo, secreto));
  const recibida = Buffer.from(firma);
  if (recibida.length !== esperada.length || !crypto.timingSafeEqual(recibida, esperada)) {
    return null;
  }

  try {
    const datos = JSON.parse(Buffer.from(cuerpo, "base64url").toString("utf8"));
    if (datos.t !== TIPO) return null;
    if (!Number.isFinite(datos.exp) || datos.exp <= ahora) return null;
    const tenantId = String(datos.tenant_id || "");
    if (!tenantId) return null;
    return { tenant_id: tenantId, operador: datos.operador === true };
  } catch (_) {
    return null;
  }
}

/**
 * Que cuenta se esta mirando de verdad, cruzando lo que pide la URL con quien lo pide.
 *
 * A UNA CLINICA SE LE IGNORA EL PARAMETRO, no se le rechaza. Rechazarlo con un error
 * distinto segun la cuenta existiera o no seria decirle cuales existen; ignorarlo no dice
 * nada y le devuelve lo suyo, que es lo que venia a ver.
 *
 * `sesion` en null es la puerta de servicio -la contraseña de entorno- y ve todo, que es
 * para lo que existe: entrar a mirar cuando la tabla de clinicas no responde.
 */
function cuentaQueSeVe(sesion, cuentaPedida) {
  if (!sesion) return cuentaPedida || null;
  if (sesion.operador) return cuentaPedida || null;
  return sesion.tenant_id;
}

/**
 * Que cuentas salen en el desplegable.
 *
 * A una clinica, la suya y nada mas. Enseñarle los nombres de las demas ya seria contarle
 * quienes son los otros clientes.
 */
function cuentasQueSeVen(sesion, todas) {
  const lista = Array.isArray(todas) ? todas : [];
  if (!sesion || sesion.operador) return lista;
  return lista.filter(c => c && c.tenant_id === sesion.tenant_id);
}

module.exports = { crearSesion, leerSesion, cuentaQueSeVe, cuentasQueSeVen, DURACION_MS };
