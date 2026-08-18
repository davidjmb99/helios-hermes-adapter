

async function testDeepSeek() {
  const payload = {
    message_text: "Hola, quiero una cita",
    patient: { phone: "+584123456789", first_name: "Test", last_name: "DeepSeek" },
    conversation: { phone: "+584123456789" },
    trace_id: "test-deepseek-" + Date.now(),
    tenant_id: "test",
    clinic_id: "test",
    channel: "whatsapp"
  };

  console.log("Enviando POST /helios/message...");
  const start = Date.now();
  const res = await fetch("http://localhost:3000/helios/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const duration = Date.now() - start;
  console.log("Status HTTP:", res.status);
  
  const text = await res.text();
  console.log("Duracion:", duration, "ms");
  console.log("Respuesta final al Gateway:", text);
}

testDeepSeek().catch(console.error);
