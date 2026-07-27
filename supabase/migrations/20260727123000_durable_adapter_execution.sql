BEGIN;

CREATE TABLE IF NOT EXISTS public.helios_adapter_executions (
  request_key text PRIMARY KEY,
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  clinic_id text NOT NULL,
  hermes_profile text NOT NULL,
  conversation_id text NOT NULL,
  contact_id text NOT NULL,
  source_message_ids_hash text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('in_progress','completed','failed_recoverable','failed_final')
  ),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  hermes_conversation_id text,
  hermes_response_id text,
  normalized_result jsonb,
  message_for_client text,
  operation jsonb,
  profile_patch jsonb,
  state_patch jsonb,
  booking_patch jsonb,
  tool_calls jsonb,
  input_tokens bigint,
  output_tokens bigint,
  total_tokens bigint,
  duration_ms bigint,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_adapter_executions_tenant_status
  ON public.helios_adapter_executions(tenant_id, status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_adapter_executions_conversation
  ON public.helios_adapter_executions(tenant_id, conversation_id, created_at DESC);

ALTER TABLE public.helios_adapter_executions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.helios_adapter_executions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.helios_adapter_executions TO service_role;

CREATE OR REPLACE FUNCTION public.claim_helios_adapter_execution(
  p_request_key text,
  p_tenant_id text,
  p_account_id text,
  p_clinic_id text,
  p_hermes_profile text,
  p_conversation_id text,
  p_contact_id text,
  p_source_message_ids_hash text,
  p_lease_owner text,
  p_lease_seconds integer DEFAULT 180
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
DECLARE
  current_row public.helios_adapter_executions%ROWTYPE;
  action text;
  inserted_count integer := 0;
BEGIN
  INSERT INTO public.helios_adapter_executions (
    request_key, tenant_id, account_id, clinic_id, hermes_profile,
    conversation_id, contact_id, source_message_ids_hash, status,
    lease_owner, lease_expires_at, attempt_count
  ) VALUES (
    p_request_key, p_tenant_id, p_account_id, p_clinic_id, p_hermes_profile,
    p_conversation_id, p_contact_id, p_source_message_ids_hash, 'in_progress',
    p_lease_owner,
    now() + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 30), 900)),
    1
  )
  ON CONFLICT (request_key) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  SELECT * INTO current_row
  FROM public.helios_adapter_executions
  WHERE request_key = p_request_key
  FOR UPDATE;

  IF current_row.tenant_id <> p_tenant_id
     OR current_row.account_id <> p_account_id
     OR current_row.clinic_id <> p_clinic_id
     OR current_row.hermes_profile <> p_hermes_profile
     OR current_row.conversation_id <> p_conversation_id
     OR current_row.contact_id <> p_contact_id
     OR current_row.source_message_ids_hash <> p_source_message_ids_hash THEN
    RAISE EXCEPTION 'adapter execution identity mismatch' USING ERRCODE = '23514';
  END IF;

  IF inserted_count = 1 THEN
    action := 'execute';
  ELSIF current_row.status = 'completed' THEN
    action := 'completed';
  ELSIF current_row.status = 'failed_final' THEN
    action := 'failed_final';
  ELSIF current_row.status = 'in_progress'
        AND current_row.lease_expires_at > now() THEN
    action := 'waiting';
  ELSE
    UPDATE public.helios_adapter_executions
    SET status = 'in_progress',
        lease_owner = p_lease_owner,
        lease_expires_at = now() + make_interval(secs => LEAST(GREATEST(p_lease_seconds, 30), 900)),
        attempt_count = attempt_count + 1,
        updated_at = now(),
        error_code = null
    WHERE request_key = p_request_key
    RETURNING * INTO current_row;
    action := 'execute';
  END IF;

  RETURN jsonb_build_object('action', action, 'execution', to_jsonb(current_row));
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_helios_adapter_execution(
  text,text,text,text,text,text,text,text,text,integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_helios_adapter_execution(
  text,text,text,text,text,text,text,text,text,integer
) TO service_role;

COMMIT;
