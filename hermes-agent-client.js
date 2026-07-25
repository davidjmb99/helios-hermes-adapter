"use strict";

function createAgentApiError(message, code, status, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  if (status) error.status = status;
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function extractResponseOutputText(responseData) {
  if (typeof responseData?.output_text === "string") {
    return responseData.output_text.trim();
  }

  const texts = [];
  for (const item of Array.isArray(responseData?.output) ? responseData.output : []) {
    if (item?.type !== "message" || item?.role !== "assistant") continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        texts.push(content.text);
      }
    }
  }
  return texts.join("\n").trim();
}

function extractResponseToolCalls(responseData) {
  const output = Array.isArray(responseData?.output) ? responseData.output : [];
  const completedCallIds = new Set(
    output
      .filter(item => item?.type === "function_call_output" && item.call_id)
      .map(item => item.call_id)
  );

  return output
    .filter(item => item?.type === "function_call" && typeof item.name === "string")
    .map(item => ({
      name: item.name,
      status: completedCallIds.has(item.call_id) ? "success" : "unknown",
      duration_ms: null,
      result_code: null
    }));
}

function extractResponseTokenUsage(responseData, toolCalls) {
  const usage = responseData?.usage || {};
  const inputTokens = Number.isFinite(usage.input_tokens) ? usage.input_tokens : null;
  const outputTokens = Number.isFinite(usage.output_tokens) ? usage.output_tokens : null;
  const totalTokens = Number.isFinite(usage.total_tokens)
    ? usage.total_tokens
    : inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens
      : null;

  return {
    exact: inputTokens !== null || outputTokens !== null || totalTokens !== null,
    model: responseData?.model || null,
    model_provider: null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cache_read_tokens: null,
    cache_write_tokens: null,
    estimated_cost: null,
    token_source: "hermes_agent_responses_api",
    cost_source: "not_available_from_hermes",
    token_lookup_attempts: [],
    tool_calls: toolCalls
  };
}

function createHermesAgentClient({
  baseUrl,
  apiKey,
  model,
  timeoutMs,
  fetchImpl = globalThis.fetch
}) {
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  const requestTimeoutMs = Number(timeoutMs || 30000);

  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required");
  }

  async function sendMessage({ input, conversation, idempotencyKey }) {
    if (!normalizedBaseUrl) {
      throw createAgentApiError(
        "HERMES_AGENT_API_BASE_URL no está configurada",
        "HERMES_AGENT_API_BASE_URL_MISSING"
      );
    }
    if (!apiKey) {
      throw createAgentApiError(
        "HERMES_AGENT_API_KEY no está configurada",
        "HERMES_AGENT_API_KEY_MISSING"
      );
    }
    if (!conversation) {
      throw createAgentApiError(
        "No se pudo construir la conversación de Hermes Agent",
        "HERMES_AGENT_CONVERSATION_MISSING"
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response;

    try {
      response = await fetchImpl(`${normalizedBaseUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
        },
        body: JSON.stringify({
          model: model || "helios",
          input: String(input || ""),
          conversation,
          store: true
        }),
        signal: controller.signal
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw createAgentApiError(
          `Hermes Agent API timed out after ${requestTimeoutMs} ms`,
          "HERMES_TIMEOUT",
          null,
          error
        );
      }
      throw createAgentApiError(
        "No se pudo conectar con Hermes Agent API",
        "HERMES_AGENT_NETWORK_ERROR",
        null,
        error
      );
    } finally {
      clearTimeout(timeout);
    }

    let responseData = null;
    try {
      responseData = await response.json();
    } catch (_) {}

    if (!response.ok) {
      const providerCode =
        responseData?.error?.code ||
        responseData?.code ||
        `HTTP_${response.status}`;
      throw createAgentApiError(
        `Hermes Agent API rechazó la solicitud (${providerCode})`,
        "HERMES_AGENT_HTTP_ERROR",
        response.status
      );
    }

    if (responseData?.status !== "completed") {
      throw createAgentApiError(
        `Hermes Agent API finalizó con estado ${responseData?.status || "unknown"}`,
        "HERMES_AGENT_INCOMPLETE_RESPONSE"
      );
    }

    const answer = extractResponseOutputText(responseData);
    if (!answer) {
      throw createAgentApiError(
        "Hermes Agent API no devolvió texto final",
        "HERMES_AGENT_EMPTY_RESPONSE"
      );
    }

    const toolCalls = extractResponseToolCalls(responseData);
    return {
      answer,
      responseId: responseData.id || "",
      model: responseData.model || model || "helios",
      toolCalls,
      tokenUsage: extractResponseTokenUsage(responseData, toolCalls)
    };
  }

  return { sendMessage };
}

module.exports = {
  createHermesAgentClient,
  extractResponseOutputText,
  extractResponseToolCalls,
  extractResponseTokenUsage
};
