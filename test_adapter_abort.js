const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const { once } = require("node:events");
const os = require("node:os");
const path = require("node:path");
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

async function waitForHealth(port, child, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Adapter exited before becoming healthy with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Adapter did not become healthy");
}

function gatewayPayload(contactId, message) {
  return {
    event: "patient_message_ready",
    account_id: "test-account",
    tenant_id: "test-tenant",
    clinic_id: "test-clinic",
    hermes_profile: "helios",
    channel: "chatwoot",
    conversation: {
      conversation_id: `conversation-${contactId}`,
      contact_id: contactId,
      inbox_id: "test-inbox",
      phone: "+584120000000"
    },
    patient: {
      profile_exists: true,
      profile_complete: false,
      name: "Test Patient",
      phone: "+584120000000"
    },
    state: { ai_enabled: true, status: "active" },
    message: {
      text: message,
      message_count: 1,
      messages: [{ id: "1", body: message }]
    },
    metadata: { trace_id: `trace-${contactId}` }
  };
}

test("Hermes stream abort returns HERMES_TIMEOUT without crashing the adapter", async (t) => {
  let hangingStreamClosed = false;
  let streamCounter = 0;

  const hermes = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/auth/login") {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "hermes_session=test; Path=/"
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/session/new") {
      streamCounter += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ session: { session_id: `session-${streamCounter}` } }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/chat/start") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const streamId = body.includes("timeout-case") ? "timeout-stream" : "normal-stream";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ stream_id: streamId }));
      });
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/chat/stream")) {
      const url = new URL(req.url, "http://127.0.0.1");
      const streamId = url.searchParams.get("stream_id");
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      });

      if (streamId === "timeout-stream") {
        req.once("close", () => { hangingStreamClosed = true; });
        res.write(": stream-open\n\n");
        return;
      }

      const contract = {
        message_for_client: "Respuesta normal",
        operation: { type: "reply", status: "success", summary: "ok" },
        profile_patch: {},
        state_patch: {},
        booking_patch: {},
        tool_calls: [],
        safe_to_send: true,
        requires_handoff: false,
        recoverable: false,
        error_code: null
      };
      res.write(`event: assistant.completed\ndata: ${JSON.stringify({ content: JSON.stringify(contract) })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  const hermesPort = await listen(hermes);
  t.after(() => hermes.close());

  const adapterPortServer = http.createServer();
  const adapterPort = await listen(adapterPortServer);
  await new Promise((resolve) => adapterPortServer.close(resolve));

  const sessionStorePath = path.join(os.tmpdir(), `helios-adapter-test-sessions-${process.pid}.json`);
  t.after(() => {
    try {
      fs.unlinkSync(sessionStorePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  });

  const child = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(adapterPort),
      HERMES_API_KEY: "test-api-key",
      HERMES_WEBUI_PASSWORD: "test-password",
      HERMES_WEBUI_BASE_URL: `http://127.0.0.1:${hermesPort}`,
      HERMES_TIMEOUT_MS: "150",
      CHATWOOT_TENANT_CONTEXTS_JSON: JSON.stringify({
        "test-account": {
          tenant_id: "test-tenant",
          clinic_id: "test-clinic",
          hermes_profile: "helios"
        }
      }),
      HERMES_SESSION_STORE_PATH: sessionStorePath,
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  });

  await waitForHealth(adapterPort, child);

  const normalResponse = await fetch(`http://127.0.0.1:${adapterPort}/helios/message`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-api-key",
      "content-type": "application/json"
    },
    body: JSON.stringify(gatewayPayload("normal", "normal-case"))
  });
  const normalBody = await normalResponse.json();
  assert.equal(normalResponse.status, 200);
  assert.equal(normalBody.ok, true);
  assert.equal(normalBody.message_for_client, "Respuesta normal");

  const timeoutResponse = await fetch(`http://127.0.0.1:${adapterPort}/helios/message`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-api-key",
      "content-type": "application/json"
    },
    body: JSON.stringify(gatewayPayload("timeout", "timeout-case"))
  });
  const timeoutBody = await timeoutResponse.json();
  assert.equal(timeoutResponse.status, 502);
  assert.equal(timeoutBody.error_code, "HERMES_TIMEOUT");

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null, `Adapter crashed.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.equal((stdout.match(/"event":"adapter_http_response_invoked".*"trace_id":"trace-timeout"/g) || []).length, 1);
  assert.doesNotMatch(stderr, /unhandledRejection|uncaughtException|triggerUncaughtException/);

  const healthResponse = await fetch(`http://127.0.0.1:${adapterPort}/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).ok, true);
  assert.equal(hangingStreamClosed, true);
});
