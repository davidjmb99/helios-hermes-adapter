"use strict";

const crypto = require("node:crypto");

class SupabaseOperationError extends Error {
  constructor(code, operation, originalError, context = {}) {
    super(`${code}: ${operation}`);
    this.name = "SupabaseOperationError";
    this.code = code;
    this.operation = operation;
    this.original_code = originalError?.code ? String(originalError.code) : null;
    this.tenant_fingerprint = fingerprint(context.tenant_id);
    this.trace_fingerprint = fingerprint(context.trace_id);
    this.row_fingerprint = fingerprint(context.row_id);
  }
}

function fingerprint(value) {
  if (value === undefined || value === null || value === "") return null;
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function classify(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  const status = Number(error?.status || error?.statusCode || 0);
  if (code.includes("TIMEOUT") || message.includes("timeout") || status === 504) return "SUPABASE_TIMEOUT";
  if (status === 401 || status === 403 || code === "42501" || message.includes("jwt")) return "SUPABASE_AUTH";
  if (code.startsWith("23") || message.includes("constraint") || message.includes("duplicate key")) {
    return "SUPABASE_CONSTRAINT";
  }
  if (status === 502 || status === 503 || message.includes("fetch failed") || message.includes("network")) {
    return "SUPABASE_NETWORK";
  }
  if (code.startsWith("42") || code.startsWith("PGRST") || message.includes("schema cache") || message.includes("column")) {
    return "SUPABASE_SCHEMA";
  }
  return "SUPABASE_UNKNOWN";
}

function assertSupabaseSuccess(result, operation, context = {}) {
  if (!result?.error) return result;
  throw new SupabaseOperationError(classify(result.error), operation, result.error, context);
}

module.exports = {
  SupabaseOperationError,
  assertSupabaseSuccess,
  fingerprint
};

