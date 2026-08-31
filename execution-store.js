"use strict";

const crypto = require("node:crypto");
const { assertSupabaseSuccess } = require("./supabase-assert");

function createExecutionStore({ supabase, leaseMs = 180000, ownerId } = {}) {
  const owner = ownerId || `adapter-${crypto.randomUUID()}`;
  const memory = new Map();

  async function claim(identity) {
    if (!supabase) {
      const existing = memory.get(identity.request_key);
      if (existing?.status === "completed") return { action: "completed", execution: existing };
      if (existing?.status === "failed_final") return { action: "failed_final", execution: existing };
      if (
        existing?.status === "in_progress" &&
        new Date(existing.lease_expires_at).getTime() > Date.now()
      ) {
        return { action: "waiting", execution: existing };
      }
      const execution = {
        ...identity,
        status: "in_progress",
        attempt_count: (existing?.attempt_count || 0) + 1,
        lease_owner: owner,
        lease_expires_at: new Date(Date.now() + leaseMs).toISOString()
      };
      memory.set(identity.request_key, execution);
      return { action: "execute", execution };
    }

    const result = await supabase.rpc("claim_helios_adapter_execution", {
      p_request_key: identity.request_key,
      p_tenant_id: identity.tenant_id,
      p_account_id: identity.account_id,
      p_clinic_id: identity.clinic_id,
      p_hermes_profile: identity.hermes_profile,
      p_conversation_id: identity.conversation_id,
      p_contact_id: identity.contact_id,
      p_source_message_ids_hash: identity.source_message_ids_hash,
      p_lease_owner: owner,
      p_lease_seconds: Math.ceil(leaseMs / 1000)
    });
    assertSupabaseSuccess(result, "adapter_execution.claim", {
      tenant_id: identity.tenant_id,
      row_id: identity.request_key
    });
    return result.data;
  }

  /**
   * Devuelve a `failed_recoverable` una ejecucion que se guardo como `completed` pero cuyo
   * resultado fue un fallo que NUNCA LLEGO AL PACIENTE.
   *
   * ES LO QUE HACE QUE UN REINTENTO VUELVA A LLAMAR A HERMES. Sin esto, la misma clave ya
   * `completed` devuelve el resultado guardado y el modelo no se toca: se repite el mismo
   * fallo, o -desde el 18 de agosto- se abandona. En los dos casos el mensaje de ese
   * paciente se pierde por un fallo que pudo ser pasajero.
   *
   * LAS CONDICIONES ESTAN EN EL `WHERE` DE LA FUNCION DE POSTGRES, no aqui, para que dos
   * peticiones simultaneas no puedan reabrir la misma ejecucion las dos. Comprobar en JS y
   * actualizar despues abriria el hueco por el que se le contesta dos veces al mismo
   * paciente.
   *
   * Devuelve `true` solo si esta llamada fue la que la reabrio.
   */
  async function reabrirSiFallo(requestKey, maxIntentos) {
    if (!Number.isInteger(maxIntentos) || maxIntentos < 1) return false;

    if (!supabase) {
      const existing = memory.get(requestKey);
      const r = existing?.normalized_result;
      if (!existing || existing.status !== "completed") return false;
      if ((existing.attempt_count || 1) > maxIntentos) return false;
      if (r?.ok !== false) return false;
      if (r?.safe_to_send !== false) return false;
      if (r?.response_sent !== false) return false;
      memory.set(requestKey, { ...existing, status: "failed_recoverable" });
      return true;
    }

    const result = await supabase.rpc("reabrir_helios_adapter_execution", {
      p_request_key: requestKey,
      p_max_intentos: maxIntentos
    });
    assertSupabaseSuccess(result, "adapter_execution.reabrir", { row_id: requestKey });
    return result.data?.reabierta === true;
  }

  async function complete(requestKey, data) {
    const payload = {
      status: "completed",
      lease_owner: null,
      lease_expires_at: null,
      hermes_conversation_id: data.hermes_conversation_id || null,
      hermes_response_id: data.hermes_response_id || null,
      normalized_result: data.normalized_result,
      message_for_client: data.normalized_result?.message_for_client || data.normalized_result?.reply || null,
      operation: data.normalized_result?.operation || null,
      profile_patch: data.normalized_result?.profile_patch || null,
      state_patch: data.normalized_result?.state_patch || null,
      booking_patch: data.normalized_result?.booking_patch || null,
      tool_calls: data.tool_calls || [],
      input_tokens: data.token_usage?.input_tokens ?? null,
      output_tokens: data.token_usage?.output_tokens ?? null,
      total_tokens: data.token_usage?.total_tokens ?? null,
      duration_ms: data.duration_ms ?? null,
      error_code: null,
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString()
    };
    if (!supabase) {
      memory.set(requestKey, { ...(memory.get(requestKey) || {}), ...payload });
      return;
    }
    const result = await supabase
      .from("helios_adapter_executions")
      .update(payload)
      .eq("request_key", requestKey)
      .eq("lease_owner", owner)
      .eq("status", "in_progress")
      .select("request_key")
      .single();
    assertSupabaseSuccess(result, "adapter_execution.complete", { row_id: requestKey });
  }

  async function fail(requestKey, errorCode, recoverable) {
    if (!requestKey) return;
    const payload = {
      status: recoverable ? "failed_recoverable" : "failed_final",
      lease_owner: null,
      lease_expires_at: null,
      error_code: errorCode,
      updated_at: new Date().toISOString()
    };
    if (!supabase) {
      memory.set(requestKey, { ...(memory.get(requestKey) || {}), ...payload });
      return;
    }
    const result = await supabase
      .from("helios_adapter_executions")
      .update(payload)
      .eq("request_key", requestKey)
      .eq("lease_owner", owner)
      .select("request_key")
      .single();
    assertSupabaseSuccess(result, "adapter_execution.fail", { row_id: requestKey });
  }

  return { claim, complete, fail, mode: supabase ? "supabase" : "memory_test",
    reabrirSiFallo
  };
}

module.exports = { createExecutionStore };
