"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createHermesAgentClient,
  extractResponseOutputText,
  inspectHermesResponseStructure
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

test("envÃ­a conversaciÃ³n nombrada, idempotencia y conserva telemetrÃ­a", async () => {
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
  assert.equal(result.httpStatus, 200);
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

test("inspectHermesResponseStructure - Casos de prueba", () => {
  const originalLog = console.log;
  let lastLog = null;
  console.log = (msg) => { lastLog = JSON.parse(msg); };

  try {
    // 1. Solo root output_text
    let res = inspectHermesResponseStructure({ id: "r1", status: "completed", output_text: "root_only" }, { trace_id: "t1", real_session_id: "s1" });
    assert.equal(res.event, "hermes_agent_response_structure");
    assert.equal(res.root_output_text_present, true);
    assert.equal(res.selected_output_source, "root_output_text");
    assert.equal(res.output_item_count, 0);
    assert.equal(lastLog.root_output_text_present, true);
    assert.equal(lastLog.real_session_id, "s1");

    // 2. Root output_text y array output simultÃ¡neamente
    res = inspectHermesResponseStructure({
      id: "r2",
      output_text: "root_text",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "array_text" }] }]
    });
    assert.equal(res.root_output_text_present, true);
    assert.equal(res.selected_output_source, "root_output_text");
    assert.equal(res.output_item_count, 1);
    assert.equal(res.assistant_message_count, 1);
    assert.equal(res.output_text_count, 1);

    // 13. Confirmar que la selecciÃ³n funcional no cambiÃ³ (si existe root, se selecciona root)
    assert.equal(res.selected_output_length, "root_text".length);

    // 3. Solo array output con un mensaje assistant
    res = inspectHermesResponseStructure({
      id: "r3",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "msg1" }] }]
    });
    assert.equal(res.root_output_text_present, false);
    assert.equal(res.selected_output_source, "output_message_content");
    assert.equal(res.selected_output_index, 0);
    assert.equal(res.selected_content_index, 0);

    // 4. Varios mensajes assistant & 14. ConcatenaciÃ³n intacta
    res = inspectHermesResponseStructure({
      id: "r4",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "msg1" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "msg2" }] }
      ]
    });
    assert.equal(res.assistant_message_count, 2);
    assert.equal(res.output_text_count, 2);
    assert.equal(res.selected_output_source, "output_message_content");
    assert.equal(res.selected_output_index, 0);
    assert.equal(res.selected_output_length, "msg1\nmsg2".length);

    // 5. Reasoning seguido de message
    res = inspectHermesResponseStructure({
      id: "r5",
      output: [
        { type: "message", role: "assistant", content: [{ type: "reasoning", text: "think" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "msg" }] }
      ]
    });
    assert.equal(res.assistant_message_count, 2);
    assert.equal(res.output_text_count, 1);
    assert.equal(res.output_text_locations[0].output_index, 1);

    // 6. Function call seguido de message
    res = inspectHermesResponseStructure({
      id: "r6",
      output: [
        { type: "function_call", name: "tool" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "msg" }] }
      ]
    });
    assert.deepEqual(res.output_item_types, ["function_call", "message"]);
    assert.equal(res.assistant_message_count, 1);
    assert.equal(res.selected_output_index, 1);

    // 7. Output vacÃ­o
    res = inspectHermesResponseStructure({ id: "r7", output: [] });
    assert.equal(res.output_item_count, 0);
    assert.equal(res.selected_output_source, "none");

    // 8. responseData.id distinto de X-Hermes-Session-Id
    res = inspectHermesResponseStructure({ id: "resp123" }, { real_session_id: "sess456" });
    assert.equal(res.response_id, "resp123");
    assert.equal(res.real_session_id, "sess456");

    // 9. Header X-Hermes-Session-Id ausente (verificado arriba cuando pasamos real_session_id: null o default)
    res = inspectHermesResponseStructure({ id: "r9" }, { real_session_id: null });
    assert.equal(res.real_session_id, null);

    // 11. Verificar hashes y longitudes sin exponer contenido
    res = inspectHermesResponseStructure({ output_text: "secret data" });
    const keys = Object.keys(res);
    assert.equal(keys.some(k => typeof res[k] === "string" && res[k].includes("secret")), false);
    assert.equal(res.root_output_text_length, 11);
    assert.ok(res.root_output_text_sha256_prefix.length === 12);

    // 12. Verificar que no aparecen nombres ni PII (los values no deben contener data del paciente)
    const jsonStr = JSON.stringify(res);
    assert.equal(jsonStr.includes("secret data"), false);

  } finally {
    console.log = originalLog;
  }
});
