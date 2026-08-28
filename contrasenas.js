/**
 * Comprobar la contraseña de una clinica, igual que hace el gateway.
 *
 * ES EL MISMO ESQUEMA A PROPOSITO -scrypt, misma etiqueta, mismo formato- para que un
 * usuario entre en los dos paneles con la misma contraseña. Si aqui se hiciera de otra
 * forma, cada clinica tendria dos contraseñas y acabarian siendo la misma escrita mal en
 * uno de los dos sitios.
 *
 * SOLO COMPRUEBA, NUNCA REESCRIBE. El gateway migra la fila a cifrado cuando alguien entra
 * con una contraseña que todavia estaba en claro. Aqui no: dos servicios escribiendo la
 * misma fila es una carrera esperando a ocurrir, y el gateway ya lo hace bien.
 *
 * Por eso se sigue aceptando el valor en claro heredado: mientras quede alguno, entrar por
 * aqui tiene que funcionar igual. Cuando el gateway los haya migrado todos, esa rama se
 * puede quitar de los dos.
 */

const crypto = require("crypto");

const ETIQUETA = "scrypt";
const LONGITUD_CLAVE = 64;

function esHashSeguro(almacenado) {
  return String(almacenado == null ? "" : almacenado).startsWith(`${ETIQUETA}$`);
}

/**
 * ¿Es esta la contraseña?
 *
 * En tiempo constante en las dos ramas: comparar con `===` tarda mas cuantos mas
 * caracteres coincidan desde el principio, y eso deja adivinarla midiendo respuestas.
 */
function verificarContrasena(contrasena, almacenado) {
  const guardado = String(almacenado == null ? "" : almacenado);
  const dada = String(contrasena == null ? "" : contrasena);
  if (!guardado || !dada) return false;

  if (!esHashSeguro(guardado)) {
    const a = Buffer.from(dada);
    const b = Buffer.from(guardado);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const partes = guardado.split("$");
  const sal = partes[1];
  const esperado = partes[2];
  if (!sal || !esperado) return false;

  try {
    const derivada = crypto.scryptSync(dada, sal, LONGITUD_CLAVE);
    const esperadoBuf = Buffer.from(esperado, "hex");
    return derivada.length === esperadoBuf.length && crypto.timingSafeEqual(derivada, esperadoBuf);
  } catch (_) {
    return false;
  }
}

module.exports = { verificarContrasena, esHashSeguro };
