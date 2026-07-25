"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createHermesAgentClient,
  extractResponseOutputText
} = require("./hermes-agent-client");

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("extrae exclusivamente el texto final del assistant", () => {
  const text = extractResponseOutputText({
    output: [
      { type: "function_call", name: "mcp_hubspot_upsert", call_id: "call_1" },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "contenido interno que no debe enviarse"
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: '{"message_for_client":"Hola"}' }]
      }
    ]
  });

  assert.equal(text, '{"message_for_client":"Hola"}');
});

test("envía conversación nombrada, idempotencia y conserva telemetría", async () => {
  let captured;
  const client = createHermesAgentClient({
    baseUrl: "http://hermes-helios:8643/",
    apiKey: "secret",
    model: "helios",
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return jsonResponse({
        id: "resp_123",
        object: "response",
        status: "completed",
        model: "helios",
        output: [
          {
            type: "function_call",
            name: "mcp_hubspot_contacts_upsert_patient_contact",
            call_id: "call_1"
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "ok"
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: '{"message_for_client":"Listo"}' }]
          }
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      });
    }
  });

  const result = await client.sendMessage({
    input: '{"message":"Hola"}',
    conversation: "helios-abc123",
    idempotencyKey: "trace-1"
  });

  assert.equal(captured.url, "http://hermes-helios:8643/v1/responses");
  assert.equal(captured.options.headers.authorization, "Bearer secret");
  assert.equal(captured.options.headers["idempotency-key"], "trace-1");
  assert.deepEqual(JSON.parse(captured.options.body), {
    model: "helios",
    input: '{"message":"Hola"}',
    conversation: "helios-abc123",
    store: true
  });
  assert.equal(result.responseId, "resp_123");
  assert.equal(result.answer, '{"message_for_client":"Listo"}');
  assert.equal(result.toolCalls[0].status, "success");
  assert.equal(result.tokenUsage.total_tokens, 15);
});

test("no filtra cuerpos del proveedor en errores HTTP", async () => {
  const client = createHermesAgentClient({
    baseUrl: "http://hermes-helios:8643",
    apiKey: "secret",
    model: "helios",
    timeoutMs: 1000,
    fetchImpl: async () =>
      jsonResponse(
        {
          error: {
            code: "provider_error",
            message: "PII que no debe aparecer"
          }
        },
        502
      )
  });

  await assert.rejects(
    client.sendMessage({
      input: "mensaje privado",
      conversation: "helios-safe",
      idempotencyKey: "trace-2"
    }),
    error => {
      assert.equal(error.code, "HERMES_AGENT_HTTP_ERROR");
      assert.equal(error.status, 502);
      assert.equal(error.message.includes("PII"), false);
      assert.equal(error.message.includes("mensaje privado"), false);
      return true;
    }
  );
});

test("rechaza respuestas incompletas o sin texto final", async () => {
  const incompleteClient = createHermesAgentClient({
    baseUrl: "http://hermes-helios:8643",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async () => jsonResponse({ id: "resp_1", status: "failed" })
  });
  await assert.rejects(
    incompleteClient.sendMessage({ input: "x", conversation: "c1" }),
    { code: "HERMES_AGENT_INCOMPLETE_RESPONSE" }
  );

  const emptyClient = createHermesAgentClient({
    baseUrl: "http://hermes-helios:8643",
    apiKey: "secret",
    timeoutMs: 1000,
    fetchImpl: async () =>
      jsonResponse({ id: "resp_2", status: "completed", output: [] })
  });
  await assert.rejects(
    emptyClient.sendMessage({ input: "x", conversation: "c2" }),
    { code: "HERMES_AGENT_EMPTY_RESPONSE" }
  );
});
