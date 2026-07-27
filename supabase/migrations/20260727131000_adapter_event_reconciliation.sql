BEGIN;

CREATE TABLE IF NOT EXISTS public.helios_adapter_reconciliation_report (
  event_id text PRIMARY KEY,
  tenant_id text,
  previous_status text NOT NULL,
  reconciled_status text NOT NULL,
  classification text NOT NULL CHECK (
    classification IN ('completed_with_evidence', 'historical_unknown')
  ),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  reconciled_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.helios_adapter_reconciliation_report ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.helios_adapter_reconciliation_report FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.helios_adapter_reconciliation_report TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_helios_adapter_event_history(
  p_older_than_minutes integer DEFAULT 10
)
RETURNS TABLE(classification text, affected_rows bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
BEGIN
  WITH candidates AS (
    SELECT e.id::text AS id,
           e.tenant_id,
           e.status,
           e.http_status,
           e.hermes_response_id,
           (
             e.hermes_response_id IS NOT NULL
             OR e.http_status BETWEEN 200 AND 299
           ) AS completed_evidence
    FROM public.helios_adapter_events e
    WHERE e.status = 'processing'
      AND COALESCE(e.started_at, e.created_at)
          <= now() - make_interval(mins => LEAST(GREATEST(p_older_than_minutes, 1), 1440))
    FOR UPDATE OF e SKIP LOCKED
  ), recorded AS (
    INSERT INTO public.helios_adapter_reconciliation_report (
      event_id,
      tenant_id,
      previous_status,
      reconciled_status,
      classification,
      evidence
    )
    SELECT
      c.id,
      c.tenant_id,
      c.status,
      CASE WHEN c.completed_evidence THEN 'completed' ELSE 'failed_final' END,
      CASE WHEN c.completed_evidence THEN 'completed_with_evidence' ELSE 'historical_unknown' END,
      jsonb_build_object(
        'http_success', c.http_status BETWEEN 200 AND 299,
        'response_id_present', c.hermes_response_id IS NOT NULL
      )
    FROM candidates c
    ON CONFLICT (event_id) DO NOTHING
    RETURNING *
  )
  UPDATE public.helios_adapter_events e
  SET status = r.reconciled_status,
      processing_stage = CASE
        WHEN r.classification = 'completed_with_evidence' THEN 'historical_completed'
        ELSE 'historical_unknown'
      END,
      telemetry_incomplete = true,
      completed_at = COALESCE(e.completed_at, now()),
      finished_at = COALESCE(e.finished_at, now()),
      error_code = CASE
        WHEN r.classification = 'historical_unknown'
        THEN COALESCE(e.error_code, 'TELEMETRY_HISTORICAL_UNKNOWN')
        ELSE e.error_code
      END
  FROM recorded r
  WHERE e.id::text = r.event_id;

  RETURN QUERY
  SELECT r.classification, count(*)::bigint
  FROM public.helios_adapter_reconciliation_report r
  GROUP BY r.classification
  ORDER BY r.classification;
END;
$function$;

REVOKE ALL ON FUNCTION public.reconcile_helios_adapter_event_history(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_helios_adapter_event_history(integer)
  TO service_role;

COMMIT;
