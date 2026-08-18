const fs = require('fs');

function applyFixes() {
  let code = fs.readFileSync('server.js', 'utf8');

  // Add withTimeout utility at the top
  const utilCode = `
function withTimeout(promise, ms, fallbackValue) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallbackValue), ms))
  ]).catch(err => {
    console.error("Timeout/Error in secondary operation:", err.message);
    return fallbackValue;
  });
}
`;
  if (!code.includes("function withTimeout")) {
    code = code.replace("const express = require('express');", "const express = require('express');\n" + utilCode);
  }

  // Refactor the POST route to return early and use withTimeout
  const oldPostSection = `    debugEvent.adapter_response_preview = JSON.stringify(normalizedResponse).slice(0, 1000);
    debugEvent.adapter_response_detail = JSON.stringify(normalizedResponse, null, 2);

    if (sessionId) {
      try {
        const { sessionData, attempts } = await fetchHermesSessionData(sessionId);
        debugEvent.token_usage = extractTokenUsage(sessionData, attempts);
      } catch (_) {}
    }

    await finishAdapterEvent(
      telemetryCtx,
      finalStatus,
      { ...normalizedResponse, response_sent: normalizedResponse.response_sent === true },
      hermesDurationMs,
      debugEvent.token_usage,
      {
        patient_display_name: requestPatientDisplayName,
          phone: requestPhone,
          hermes_first_token_ms: typeof hermesFirstTokenMs !== 'undefined' ? hermesFirstTokenMs : null,
          session_id: sessionId,
          stream_id: streamId,
          processing_stage: processingStage,
        display_name_source: getDisplayNameSource(normalized?.patient),
        message_preview: maskPreview(normalized?.message_text),
        message_count: normalized?.message_count,
        intent: finalIntent,
        response_preview: extractResponsePreview(normalizedResponse),
        route: finalRoute,
      }
    );

    processingStage = "response_returned";
    return res.json(normalizedResponse);`;

  const newPostSection = `    debugEvent.adapter_response_preview = JSON.stringify(normalizedResponse).slice(0, 1000);
    debugEvent.adapter_response_detail = JSON.stringify(normalizedResponse, null, 2);

    // Send HTTP response early so Gateway doesn't hang
    processingStage = "response_returned";
    res.json(normalizedResponse);

    // Secondary tasks with timeouts
    if (sessionId) {
      try {
        const result = await withTimeout(
          fetchHermesSessionData(sessionId),
          3000,
          { sessionData: null, attempts: [] }
        );
        debugEvent.token_usage = extractTokenUsage(result.sessionData, result.attempts);
      } catch (err) {
        console.error("Error fetching session data:", err.message);
      }
    }

    try {
      await withTimeout(
        finishAdapterEvent(
          telemetryCtx,
          finalStatus,
          { ...normalizedResponse, response_sent: true }, // since we just sent it
          hermesDurationMs,
          debugEvent.token_usage,
          {
            patient_display_name: requestPatientDisplayName,
            phone: requestPhone,
            hermes_first_token_ms: typeof hermesFirstTokenMs !== 'undefined' ? hermesFirstTokenMs : null,
            session_id: sessionId,
            stream_id: streamId,
            processing_stage: processingStage,
            display_name_source: getDisplayNameSource(normalized?.patient),
            message_preview: maskPreview(normalized?.message_text),
            message_count: normalized?.message_count,
            intent: finalIntent,
            response_preview: extractResponsePreview(normalizedResponse),
            route: finalRoute,
          }
        ),
        3000,
        null
      );
    } catch (err) {
      console.error("Supabase telemetry error:", err.message);
    }`;

  if (code.includes(oldPostSection)) {
    code = code.replace(oldPostSection, newPostSection);
    fs.writeFileSync('server.js', code);
    console.log("Fixes applied successfully.");
  } else {
    console.log("Could not find post block in server.js! Retrying with regex...");
    
    // Sometimes whitespace mismatches. Let's do smaller replacements
    const oldTelemetry = `    if (sessionId) {
      try {
        const { sessionData, attempts } = await fetchHermesSessionData(sessionId);
        debugEvent.token_usage = extractTokenUsage(sessionData, attempts);
      } catch (_) {}
    }`;
    const newTelemetry = `    // Send HTTP response early so Gateway doesn't hang
    processingStage = "response_returned";
    res.json(normalizedResponse);

    // Secondary tasks with timeouts
    if (sessionId) {
      try {
        const result = await withTimeout(
          fetchHermesSessionData(sessionId),
          3000,
          { sessionData: null, attempts: [] }
        );
        debugEvent.token_usage = extractTokenUsage(result.sessionData, result.attempts);
      } catch (err) {}
    }`;
    code = code.replace(oldTelemetry, newTelemetry);
    
    const oldFinish = `    await finishAdapterEvent(
      telemetryCtx,
      finalStatus,
      { ...normalizedResponse, response_sent: normalizedResponse.response_sent === true },
      hermesDurationMs,
      debugEvent.token_usage,
      {
        patient_display_name: requestPatientDisplayName,
          phone: requestPhone,
          hermes_first_token_ms: typeof hermesFirstTokenMs !== 'undefined' ? hermesFirstTokenMs : null,
          session_id: sessionId,
          stream_id: streamId,
          processing_stage: processingStage,
        display_name_source: getDisplayNameSource(normalized?.patient),
        message_preview: maskPreview(normalized?.message_text),
        message_count: normalized?.message_count,
        intent: finalIntent,
        response_preview: extractResponsePreview(normalizedResponse),
        route: finalRoute,
      }
    );

    processingStage = "response_returned";
    return res.json(normalizedResponse);`;
    
    const newFinish = `    try {
      await withTimeout(
        finishAdapterEvent(
          telemetryCtx,
          finalStatus,
          { ...normalizedResponse, response_sent: true }, // since we just sent it
          hermesDurationMs,
          debugEvent.token_usage,
          {
            patient_display_name: requestPatientDisplayName,
            phone: requestPhone,
            hermes_first_token_ms: typeof hermesFirstTokenMs !== 'undefined' ? hermesFirstTokenMs : null,
            session_id: sessionId,
            stream_id: streamId,
            processing_stage: processingStage,
            display_name_source: getDisplayNameSource(normalized?.patient),
            message_preview: maskPreview(normalized?.message_text),
            message_count: normalized?.message_count,
            intent: finalIntent,
            response_preview: extractResponsePreview(normalizedResponse),
            route: finalRoute,
          }
        ),
        3000,
        null
      );
    } catch (err) {}`;
    code = code.replace(oldFinish, newFinish);
    
    fs.writeFileSync('server.js', code);
    console.log("Fixes applied via fallback replacement.");
  }
}

applyFixes();
