-- La caja negra del salto Hermes -> Adapter.
--
-- POR QUE EXISTE. De los siete saltos que hace un mensaje, seis se pueden mirar en
-- SQL. El unico que no es lo que Hermes devuelve por HTTP, y resulta que ahi es
-- donde falla. Sin verlo, todo lo que se diga sobre la causa es una hipotesis: se
-- probaron cinco y fallaron las cinco.
--
-- Los logs no sirven para esto. Se intento tres veces y las tres se perdieron: la
-- primera por el auto-refresco del panel llenando el fichero, la segunda por la
-- ventana de cien lineas de Coolify, la tercera porque el proceso reventaba antes.
-- SQL si ha funcionado siempre.
--
-- Solo se rellena CUANDO EL CONTRATO FALLA. En un turno normal la columna queda
-- NULL y no ocupa nada.

BEGIN;

ALTER TABLE public.helios_adapter_events
  ADD COLUMN IF NOT EXISTS contract_debug jsonb;

COMMENT ON COLUMN public.helios_adapter_events.contract_debug IS
  'Solo cuando el contrato falla: texto crudo recibido de Hermes y forma de su respuesta. Para diagnosticar sin depender de logs.';

COMMIT;
