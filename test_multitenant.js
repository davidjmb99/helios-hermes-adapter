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

async function waitForHealth(port, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Adapter exited before health check");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Adapter health check timed out");
}

function payload(context, traceId) {
  return {
    event: "patient_message_ready",
    account_id: context.account_id,
    tenant_id: context.tenant_id,
    clinic_id: context.clinic_id,
    hermes_profile: context.hermes_profile,
    channel: "chatwoot",
    conversation: {
      conversation_id: "same-conversation",
      contact_id: "same-contact",
      inbox_id: "inbox",
      phone: "+00000000000"
    },
    patient: {
      profile_exists: true,
      profile_complete: false,
      phone: "+00000000000",
      email: "private-marker@example.invalid"
    },
    state: { ai_enabled: true, status: "new" },
    message: {
      text: "PRIVATE_MULTITENANT_MARKER",
      message_count: 1,
      messages: [{ id: traceId, body: "PRIVATE_MULTITENANT_MARKER" }]
    },
    metadata: { trace_id: traceId, retry_count: 0 }
  };
}

test("tenant context isolates sessions and sends explicit profiles", async (t) => {
  const contexts = {
    "2": {
      account_id: "2",
      tenant_id: "democoi1",
      clinic_id: "coi_demo",
      hermes_profile: "helios"
    },
    "3": {
      account_id: "3",
      tenant_id: "tenant-other",
      clinic_id: "clinic-other",
      hermes_profile: "profile-other"
    }
  };
  const sessionBodies = [];
  const chatBodies = [];
  let sessionCounter = 0;

  const hermes = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/auth/login") {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "hermes_session=test; Path=/"
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && ["/api/session/new", "/api/chat/start"].includes(req.url)) {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw);
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url === "/api/session/new") {
          sessionBodies.push(body);
          sessionCounter += 1;
          res.end(JSON.stringify({ session: { session_id: `session-${sessionCounter}` } }));
        } else {
          chatBodies.push(body);
          res.end(JSON.stringify({ stream_id: `stream-${body.session_id}` }));
        }
      });
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/chat/stream")) {
      const contract = {
        message_for_client: "Respuesta segura",
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
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: assistant.completed\ndata: ${JSON.stringify({ content: JSON.stringify(contract) })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  const hermesPort = await listen(hermes);
  t.after(() => hermes.close());

  const portProbe = http.createServer();
  const adapterPort = await listen(portProbe);
  await new Promise((resolve) => portProbe.close(resolve));

  const sessionStorePath = path.join(os.tmpdir(), `adapter-multitenant-${process.pid}.json`);
  t.after(() => {
    try { fs.unlinkSync(sessionStorePath); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  });

  const child = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(adapterPort),
      HERMES_API_KEY: "test-api-key",
      HERMES_PROFILE: "wrong-global-profile",
      HERMES_WEBUI_PASSWORD: "test-password",
      HERMES_WEBUI_BASE_URL: `http://127.0.0.1:${hermesPort}`,
      HERMES_TIMEOUT_MS: "2000",
      HERMES_SESSION_STORE_PATH: sessionStorePath,
      CHATWOOT_TENANT_CONTEXTS_JSON: JSON.stringify(contexts),
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  });
  await waitForHealth(adapterPort, child);

  async function send(body) {
    return fetch(`http://127.0.0.1:${adapterPort}/helios/message`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-api-key",
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
  }

  const heliosResponse = await send(payload(contexts["2"], "trace-helios"));
  assert.equal(heliosResponse.status, 200);
  assert.equal((await heliosResponse.json()).ok, true);

  const otherResponse = await send(payload(contexts["3"], "trace-other"));
  assert.equal(otherResponse.status, 200);
  assert.equal((await otherResponse.json()).ok, true);

  assert.equal(sessionBodies.length, 2);
  assert.deepEqual(sessionBodies.map((body) => body.profile), ["helios", "profile-other"]);
  assert.deepEqual(chatBodies.map((body) => body.profile), ["helios", "profile-other"]);
  assert.notEqual(chatBodies[0].session_id, chatBodies[1].session_id);
  assert.equal(sessionBodies.some((body) => body.profile === "wrong-global-profile"), false);

  const sessionKeys = Object.keys(
    JSON.parse(fs.readFileSync(sessionStorePath, "utf8"))
  );
  assert.ok(
    sessionKeys.includes(
      "tenant:democoi1:profile:helios:conversation:same-conversation:contact:same-contact"
    )
  );
  assert.equal(
    sessionKeys.some((key) => key.startsWith("tenant:2:")),
    false,
    "account_id=2 must never become tenant_id=2 in session state"
  );

  const unknown = payload({
    account_id: "999",
    tenant_id: "unknown",
    clinic_id: "unknown",
    hermes_profile: "default"
  }, "trace-unknown");
  const unknownResponse = await send(unknown);
  assert.equal(unknownResponse.status, 422);
  assert.equal((await unknownResponse.json()).error_code, "TENANT_NOT_CONFIGURED");
  assert.equal(sessionBodies.length, 2, "Unknown account must not call Hermes");

  const mismatch = payload({ ...contexts["2"], hermes_profile: "default" }, "trace-mismatch");
  const mismatchResponse = await send(mismatch);
  assert.equal(mismatchResponse.status, 422);
  assert.equal((await mismatchResponse.json()).error_code, "TENANT_CONTEXT_MISMATCH");
  assert.equal(sessionBodies.length, 2, "Mismatched profile must not call Hermes");

  assert.doesNotMatch(output, /PRIVATE_MULTITENANT_MARKER|private-marker@example\.invalid|\+00000000000/);
});
