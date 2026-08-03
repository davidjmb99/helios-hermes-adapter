"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const { once } = require("node:events");
const test = require("node:test");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Adapter exited before health check (${child.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response.json();
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Adapter health check timed out");
}

function gatewayPayload() {
  return {
    event: "patient_message_ready",
    account_id: "test-account",
    tenant_id: "test-tenant",
    clinic_id: "test-clinic",
    hermes_profile: "helios",
    channel: "chatwoot",
    conversation: {
      conversation_id: "conversation-32",
      contact_id: "contact-6",
      inbox_id: "inbox-1",
      phone: "+584120000000"
    },
    patient: {
      profile_exists: true,
      profile_complete: false,
      name: "Private Test Patient",
      phone: "+584120000000"
    },
    state: { ai_enabled: true, status: "active" },
    message: {
      text: "PRIVATE_AGENT_API_MARKER",
      message_count: 1,
      messages: [{ id: "message-1", body: "PRIVATE_AGENT_API_MARKER" }]
    },
    metadata: { trace_id: "trace-agent-api-1" }
  };
}

test("adapter completes the production route through Hermes Agent API", async (t) => {
  const requests = [];
  const agentApi = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.writeHead(404).end();
      return;
    }

    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      requests.push({
        authorization: req.headers.authorization,
        idempotencyKey: req.headers["idempotency-key"],
        body: JSON.parse(raw)
      });

      const contract = {
        message_for_client: "Claro, te ayudo con tu cita.",
        route: "hermes",
        intent: "solicitar_cita",
        operation: {
          type: "booking",
          status: "pending",
          summary: "Recopilar datos para la cita"
        },
        profile_patch: {},
        state_patch: { pending_intent: "solicitar_cita" },
        booking_patch: {},
        tool_calls: [],
        safe_to_send: true,
        requires_handoff: false,
        recoverable: false,
        error_code: null
      };

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "resp_agent_1",
        object: "response",
        status: "completed",
        model: "helios",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: JSON.stringify(contract) }]
          }
        ],
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }
      }));
    });
  });
  const agentPort = await listen(agentApi);
  t.after(() => agentApi.close());

  const portProbe = http.createServer();
  const adapterPort = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));

  const child = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(adapterPort),
      HERMES_API_KEY: "adapter-shared-secret",
      HERMES_PROFILE: "helios",
      HERMES_TRANSPORT: "agent_api",
      HERMES_AGENT_API_BASE_URL: `http://127.0.0.1:${agentPort}`,
      HERMES_AGENT_API_KEY: "agent-api-secret",
      HERMES_AGENT_MODEL: "helios",
      HERMES_TIMEOUT_MS: "2000",
      CHATWOOT_TENANT_CONTEXTS_JSON: JSON.stringify({
        "test-account": {
          tenant_id: "test-tenant",
          clinic_id: "test-clinic",
          hermes_profile: "helios"
        }
      }),
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  });

  const health = await waitForHealth(adapterPort, child);
  assert.equal(health.hermes_transport, "agent_api");
  assert.equal(health.hermes_agent_api_base_url_configured, true);
  assert.equal(health.hermes_agent_api_key_configured, true);
  assert.equal(JSON.stringify(health).includes("agent-api-secret"), false);

  const response = await fetch(`http://127.0.0.1:${adapterPort}/helios/message`, {
    method: "POST",
    headers: {
      authorization: "Bearer adapter-shared-secret",
      "content-type": "application/json"
    },
    body: JSON.stringify(gatewayPayload())
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.message_for_client, "Claro, te ayudo con tu cita.");
  assert.equal(body.intent, "solicitar_cita");
  assert.equal(body.operation_type, "booking");
  assert.equal(body.operation_status, "pending");
  assert.equal(body.has_state_patch, true);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, "Bearer agent-api-secret");
  assert.match(requests[0].idempotencyKey, /^helios-[a-f0-9]{64}$/);
  assert.notEqual(requests[0].idempotencyKey, "trace-agent-api-1");
  assert.equal(requests[0].body.model, "helios");
  assert.equal(requests[0].body.store, true);
  assert.match(requests[0].body.conversation, /^helios-[a-f0-9]{12}$/);
  assert.match(requests[0].body.input, /PRIVATE_AGENT_API_MARKER/);
  assert.match(requests[0].body.input, /OUTPUT CONTRACT \(REQUIRED\)/);
  assert.match(requests[0].body.input, /message_for_client/);

  const duplicateResponse = await fetch(`http://127.0.0.1:${adapterPort}/helios/message`, {
    method: "POST",
    headers: {
      authorization: "Bearer adapter-shared-secret",
      "content-type": "application/json"
    },
    body: JSON.stringify(gatewayPayload())
  });
  const duplicateBody = await duplicateResponse.json();
  assert.equal(duplicateResponse.status, 200);
  assert.equal(duplicateBody.message_for_client, "Claro, te ayudo con tu cita.");
  assert.equal(requests.length, 1, "a repeated request_key must not call Hermes twice");

  await new Promise(resolve => setTimeout(resolve, 50));
  assert.doesNotMatch(output, /agent-api-secret|adapter-shared-secret/);
  assert.doesNotMatch(output, /PRIVATE_AGENT_API_MARKER|Private Test Patient|\+584120000000/);
  assert.match(output, /"transport":"agent_api"/);
});
