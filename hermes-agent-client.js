"use strict";

const crypto = require("crypto");

function sha256Prefix(text) {
  if (typeof text !== "string") return null;
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").substring(0, 12);
}

function inspectHermesResponseStructure(responseData, metadata = {}) {
  const rootOutputTextPresent = typeof responseData?.output_text === "string";
  const rootOutputTextLength = rootOutputTextPresent ? responseData.output_text.length : null;
  const rootOutputTextSha256 = rootOutputTextPresent ? sha256Prefix(responseData.output_text) : null;

  const outputArray = Array.isArray(responseData?.output) ? responseData.output : [];
  const outputItemCount = outputArray.length;
  const outputItemTypes = outputArray.map(item => item?.type || "unknown");

  let assistantMessageCount = 0;
  let outputTextCount = 0;
  const outputTextLocations = [];

  for (let i = 0; i < outputArray.length; i++) {
    const item = outputArray[i];
    if (item?.type === "message" && item?.role === "assistant") {
      assistantMessageCount++;
    }
    const contentArray = Array.isArray(item?.content) ? item.content : [];
    for (let j = 0; j < contentArray.length; j++) {
      const content = contentArray[j];
      if (content?.type === "output_text" && typeof content.text === "string") {
        outputTextCount++;
        outputTextLocations.push({
          output_index: i,
          content_index: j,
          item_type: item?.type || null,
          role: item?.role || null,
          content_type: "output_text",
          length: content.text.length,
          sha256_prefix: sha256Prefix(content.text)
        });
      }
    }
  }

  let selectedOutputSource = "none";
  let selectedOutputIndex = null;
  let selectedContentIndex = null;

  if (rootOutputTextPresent) {
    selectedOutputSource = "root_output_text";
  } else {
    let firstFound = false;
    for (const loc of outputTextLocations) {
      if (loc.item_type === "message" && loc.role === "assistant") {
        if (!firstFound) {
          selectedOutputIndex = loc.output_index;
          selectedContentIndex = loc.content_index;
          firstFound = true;
        }
      }
    }
    if (firstFound) {
      selectedOutputSource = "output_message_content";
    }
  }

  const answer = extractResponseOutputText(responseData);
  const selectedOutputLength = typeof answer === "string" ? answer.length : 0;
  const selectedOutputSha256Prefix = typeof answer === "string" ? sha256Prefix(answer) : null;

  const telemetryEvent = {
    event: "hermes_agent_response_structure",
    trace_id: metadata.trace_id || null,
    response_id: responseData?.id || null,
    real_session_id: metadata.real_session_id || null,
    response_status: responseData?.status || null,
    root_output_text_present: rootOutputTextPresent,
    root_output_text_length: rootOutputTextLength,
    root_output_text_sha256_prefix: rootOutputTextSha256,
    output_item_count: outputItemCount,
    output_item_types: outputItemTypes,
    assistant_message_count: assistantMessageCount,
    output_text_count: outputTextCount,
    output_text_locations: outputTextLocations,
    selected_output_source: selectedOutputSource,
    selected_output_index: selectedOutputIndex,
    selected_content_index: selectedContentIndex,
    selected_output_length: selectedOutputLength,
    selected_output_sha256_prefix: selectedOutputSha256Prefix
  };

  console.log(JSON.stringify(telemetryEvent));
  return telemetryEvent;
}

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

  async function sendMessage({ input, conversation, idempotencyKey, traceId }) {
    if (!normalizedBaseUrl) {
      throw createAgentApiError(
        "HERMES_AGENT_API_BASE_URL no estÃ¡ configurada",
        "HERMES_AGENT_API_BASE_URL_MISSING"
      );
    }
    if (!apiKey) {
      throw createAgentApiError(
        "HERMES_AGENT_API_KEY no estÃ¡ configurada",
        "HERMES_AGENT_API_KEY_MISSING"
      );
    }
    if (!conversation) {
      throw createAgentApiError(
        "No se pudo construir la conversaciÃ³n de Hermes Agent",
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
    let realSessionId = null;
    try {
      realSessionId = response.headers.get("x-hermes-session-id") || response.headers.get("X-Hermes-Session-Id") || null;
      responseData = await response.json();
    } catch (_) {}

    if (!response.ok) {
      const providerCode =
        responseData?.error?.code ||
        responseData?.code ||
        `HTTP_${response.status}`;
      throw createAgentApiError(
        `Hermes Agent API rechazÃ³ la solicitud (${providerCode})`,
        "HERMES_AGENT_HTTP_ERROR",
        response.status
      );
    }

    if (responseData?.status !== "completed") {
      throw createAgentApiError(
        `Hermes Agent API finalizÃ³ con estado ${responseData?.status || "unknown"}`,
        "HERMES_AGENT_INCOMPLETE_RESPONSE"
      );
    }

    const answer = extractResponseOutputText(responseData);

    inspectHermesResponseStructure(responseData, {
      trace_id: traceId,
      real_session_id: realSessionId
    });

    if (!answer) {
      throw createAgentApiError(
        "Hermes Agent API no devolviÃ³ texto final",
        "HERMES_AGENT_EMPTY_RESPONSE"
      );
    }

    const toolCalls = extractResponseToolCalls(responseData);
    return {
      answer,
      httpStatus: response.status,
      responseId: responseData.id || "",
      sessionId: realSessionId,
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
  extractResponseTokenUsage,
  inspectHermesResponseStructure
};
