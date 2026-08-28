/**
 * Ver el panel del adapter de una clinica sola, o de todas.
 *
 * AQUI LA CUENTA ES UN FILTRO DE VISTA, NO UN PERMISO, y esa diferencia hay que dejarla
 * escrita porque parece contradecir la regla 111 -«cambiar de cuenta es cambiar de token,
 * nunca mandar un tenant_id»- y no la contradice.
 *
 * En el GATEWAY el panel lo abre una clinica, asi que la cuenta define QUE PUEDE VER: sale
 * del token firmado y no hay ningun parametro para elegirla, porque manipular el navegador
 * abriria los datos de otra clinica.
 *
 * En el ADAPTER el panel lo abre el equipo tecnico -ESCALA365- y ya ve todas las cuentas de
 * todas formas. Elegir una no le da acceso a nada que no tuviera: le quita ruido de encima.
 * Un parametro aqui no abre ninguna puerta porque no habia puerta.
 *
 * EL DIA QUE UNA CLINICA ENTRE AL ADAPTER, ESTO DEJA DE VALER y hay que hacerlo como en el
 * gateway. Escrito aqui para que ese dia se lea antes de copiar el patron.
 *
 * Y POR QUE HACIA FALTA: sin filtro, el gasto del panel SUMA TODAS LAS CLINICAS. Con una
 * sola no se nota; con dos, la cifra deja de significar nada y se usa para decidir.
 */

/** Un tenant_id es corto y de letras, numeros, guiones y guiones bajos. Nada mas. */
const FORMA_DE_CUENTA = /^[a-zA-Z0-9_-]{1,64}$/;

/** Lo que significa «todas»: la ausencia de filtro. */
const TODAS = null;

/**
 * Que cuenta hay que mirar, a partir de lo que llega en la URL.
 *
 * Devuelve `null` para «todas» -que es el defecto y lo que habia antes- y una cadena para
 * una sola. Devuelve `{ error }` si lo que llega no tiene forma de cuenta: mejor decirlo
 * que enseñar el total de todas creyendo que se esta viendo una.
 */
function leerCuenta(valor) {
  if (valor === undefined || valor === null) return { cuenta: TODAS };

  const bruto = String(valor).trim();
  // Vacio y «todas» son la misma peticion, escrita de dos formas. El desplegable manda una
  // cadena vacia al volver a «Todas», y un enlace escrito a mano puede traer la palabra.
  if (!bruto || bruto.toLowerCase() === 'todas') return { cuenta: TODAS };

  if (!FORMA_DE_CUENTA.test(bruto)) return { error: 'CUENTA_INVALIDA' };
  return { cuenta: bruto };
}

/**
 * Aplica el filtro a una consulta de Supabase.
 *
 * SE PASA LA CONSULTA Y SE DEVUELVE, en vez de montar el `.eq` en cada sitio: asi los dos
 * endpoints filtran igual y no puede pasar que uno se quede sin filtrar y enseñe el total
 * de todas las clinicas con el desplegable diciendo que es una.
 */
function filtrarPorCuenta(consulta, cuenta) {
  return cuenta ? consulta.eq('tenant_id', cuenta) : consulta;
}

/**
 * Las cuentas que hay, ordenadas, a partir de las filas de tenants.
 *
 * SIN NOMBRE SE USA EL ID. Una clinica recien dada de alta puede no tener nombre todavia, y
 * es peor que desaparezca del desplegable que verla con su identificador.
 */
function cuentasDeFilas(filas) {
  const vistas = new Map();
  for (const fila of filas || []) {
    const id = String(fila?.tenant_id || '').trim();
    if (!id || vistas.has(id)) continue;
    vistas.set(id, {
      tenant_id: id,
      nombre: String(fila?.name || '').trim() || id
    });
  }
  return [...vistas.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

module.exports = { leerCuenta, filtrarPorCuenta, cuentasDeFilas, FORMA_DE_CUENTA };
