"use strict";

let cachedRaw = null;
let cachedByAccount = new Map();

class TenantContextError extends Error {
  constructor(code, message, accountId = null) {
    super(message);
    this.name = "TenantContextError";
    this.code = code;
    this.account_id = accountId;
  }
}

function requiredString(value, field, accountId) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new TenantContextError(
      "TENANT_CONTEXT_INVALID",
      `Tenant context ${accountId} is missing ${field}`,
      accountId
    );
  }
  return normalized;
}

function loadTenantContexts() {
  const raw = String(process.env.CHATWOOT_TENANT_CONTEXTS_JSON ?? "").trim();
  if (raw === cachedRaw) return;
  if (!raw) {
    throw new TenantContextError(
      "TENANT_CONTEXT_INVALID",
      "CHATWOOT_TENANT_CONTEXTS_JSON is not configured"
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new TenantContextError(
      "TENANT_CONTEXT_INVALID",
      "CHATWOOT_TENANT_CONTEXTS_JSON is not valid JSON"
    );
  }

  const entries = Array.isArray(parsed)
    ? parsed.map((item) => [String(item?.account_id ?? ""), item])
    : Object.entries(parsed);
  const byAccount = new Map();
  const tenantIds = new Set();

  for (const [key, value] of entries) {
    const accountId = requiredString(value?.account_id ?? key, "account_id", key);
    const context = Object.freeze({
      account_id: accountId,
      tenant_id: requiredString(value?.tenant_id, "tenant_id", accountId),
      clinic_id: requiredString(value?.clinic_id, "clinic_id", accountId),
      hermes_profile: requiredString(value?.hermes_profile, "hermes_profile", accountId)
    });

    if (byAccount.has(accountId) || tenantIds.has(context.tenant_id)) {
      throw new TenantContextError(
        "TENANT_CONTEXT_INVALID",
        "Duplicate account_id or tenant_id in tenant context map",
        accountId
      );
    }
    byAccount.set(accountId, context);
    tenantIds.add(context.tenant_id);
  }

  cachedRaw = raw;
  cachedByAccount = byAccount;
}

function resolveTenantContext(accountId) {
  loadTenantContexts();
  const normalizedAccountId = String(accountId ?? "").trim();
  const context = cachedByAccount.get(normalizedAccountId);
  if (!context) {
    throw new TenantContextError(
      "TENANT_NOT_CONFIGURED",
      "Chatwoot account is not configured",
      normalizedAccountId || null
    );
  }
  return context;
}

function validateTenantContext(input) {
  const context = resolveTenantContext(input?.account_id);
  const matches =
    String(input?.tenant_id ?? "").trim() === context.tenant_id &&
    String(input?.clinic_id ?? "").trim() === context.clinic_id &&
    String(input?.hermes_profile ?? "").trim() === context.hermes_profile;

  if (!matches) {
    throw new TenantContextError(
      "TENANT_CONTEXT_MISMATCH",
      "Received tenant context does not match configured Chatwoot account",
      context.account_id
    );
  }
  return context;
}

module.exports = {
  TenantContextError,
  resolveTenantContext,
  validateTenantContext
};
