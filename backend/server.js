// Backend proxy for SnapTrade APIs.
// Responsibilities:
// - Expose a small REST API for the React admin UI.
// - Forward requests to SnapTrade with proper auth.
// - Provide verbose, safe logging to debug integration issues.
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const {
  Snaptrade,
  AccountInformationApiGenerated,
  ReferenceDataApiGenerated,
  Configuration,
} = require("snaptrade-typescript-sdk");

// Load environment variables from .env file
require("dotenv").config();

const app = express();
// Prefer the dynamically assigned port from the root dev orchestrator.
// If it's missing, default to 0 (random free port) to avoid Windows EADDRINUSE issues
// during nodemon restarts.
const PORT = Number(process.env.BACKEND_PORT || 0);

// Enable CORS for all routes
app.use(cors());
app.use(express.json());

/**
 * Safely stringify request/response data for logs.
 * Avoids throwing when data contains circular references.
 */
function safeString(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Produce a short SHA256 fingerprint for secrets so we can compare values
 * across logs without printing the secret itself.
 */
function fingerprint(value) {
  if (!value) return null;
  try {
    const h = crypto.createHash("sha256").update(String(value)).digest("hex");
    // Short fingerprint is enough to compare values across logs without leaking the secret.
    return `sha256:${h.slice(0, 12)}`;
  } catch {
    return "sha256:ERROR";
  }
}

/**
 * Mask all but the last few characters of a value for log output.
 */
function maskLast(value, keep = 4) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= keep) return "*".repeat(s.length);
  return `${"*".repeat(Math.max(0, s.length - keep))}${s.slice(-keep)}`;
}

/**
 * Log axios-like errors (SnapTrade SDK uses axios internally) with enough
 * request/response detail to debug auth and request-shape issues.
 */
function logAxiosLikeError(prefix, err) {
  // Handles axios-like errors (SnapTrade SDK uses axios under the hood)
  const status = err?.response?.status;
  const statusText = err?.response?.statusText;
  const data = err?.response?.data;

  console.error(`\n[${prefix}] ERROR ----------------------------------------`);
  console.error("message:", err?.message);
  if (err?.code) console.error("code:", err.code);
  if (status || statusText) console.error("status:", status, statusText);

  if (err?.config) {
    console.error("request:", {
      method: err.config?.method,
      url: err.config?.url,
      baseURL: err.config?.baseURL,
      timeout: err.config?.timeout,
      headers: err.config?.headers,
      params: err.config?.params,
      data: safeString(err.config?.data),
    });
  }

  if (err?.response) {
    console.error("response headers:", err.response?.headers);
    console.error("response data:", data);

    // SnapTrade sometimes returns JSON bodies as strings. Try to parse and pretty print.
    try {
      if (typeof data === "string") {
        const trimmed = data.trim();
        if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
          const parsed = JSON.parse(trimmed);
          console.error("response data (json):", JSON.stringify(parsed, null, 2));
        }
      }
    } catch {
      // ignore parse failures
    }

    // If the API provides a JSON error body (common for 401s), stringify it so it's easy to copy/paste.
    try {
      if (data && typeof data === "object") {
        console.error("response data (json):", JSON.stringify(data, null, 2));
      }
    } catch {
      // ignore stringify failures
    }
  }

  if (err?.stack) console.error("stack:\n", err.stack);
  console.error(`[${prefix}] END ERROR ------------------------------------\n`);
}

/**
 * Pretty-print a JSON payload and truncate it to keep logs readable.
 */
function safePreviewJson(value, maxLen = 4000) {
  try {
    const s = JSON.stringify(value, null, 2);
    if (s.length <= maxLen) return s;
    return `${s.slice(0, maxLen)}\n... (truncated ${s.length - maxLen} chars)`;
  } catch (e) {
    return `<<unserializable: ${e?.message || "unknown"}>>`;
  }
}

/**
 * Provide a lightweight summary of the accounts response so we can
 * see basic shape/keys without dumping the entire payload every time.
 */
function summarizeAccountsResponse(data) {
  // SnapTrade shapes vary across versions, but typically an array of account objects.
  if (!data) return { kind: typeof data, count: 0 };
  if (Array.isArray(data)) {
    const first = data[0];
    return {
      kind: "array",
      count: data.length,
      firstKeys: first && typeof first === "object" ? Object.keys(first).slice(0, 30) : null,
      firstId:
        first?.id ||
        first?.accountId ||
        first?.brokerageAccountId ||
        first?.snapTradeAccountId ||
        null,
      firstName: first?.name || first?.accountName || null,
    };
  }
  if (typeof data === "object") {
    return {
      kind: "object",
      keys: Object.keys(data).slice(0, 50),
    };
  }
  return { kind: typeof data };
}

// Request logging (helps correlate UI calls with backend errors)
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`[RES] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// Simple in-memory store for user secrets (in production, use a proper database)
const userSecrets = new Map();

const SNAPTRADE_ENV_VALUES = ["production", "development"];
const DEFAULT_SNAPTRADE_ENV = normalizeSnapTradeEnv(
  process.env.SNAPTRADE_ENV || "production"
);
const FRONT_END_URL = process.env.FRONT_END_URL;
const SUPABASE_TABLE = "snaptrade_users";

const SNAPTRADE_ENVIRONMENTS = {
  production: {
    clientId:
      process.env.SNAPTRADE_PRODUCTION_CLIENT_ID ||
      process.env.SNAPTRADE_CLIENT_ID ||
      null,
    consumerKey:
      process.env.SNAPTRADE_PRODUCTION_CONSUMER_KEY ||
      process.env.SNAPTRADE_CONSUMER_KEY ||
      null,
  },
  development: {
    clientId: process.env.SNAPTRADE_DEVELOPMENT_CLIENT_ID || null,
    consumerKey: process.env.SNAPTRADE_DEVELOPMENT_CONSUMER_KEY || null,
  },
};

const snaptradeContexts = new Map();
const SUPABASE_ENVIRONMENTS = {
  production: {
    url:
      process.env.SUPABASE_PRODUCTION_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      null,
    key:
      process.env.SUPABASE_PRODUCTION_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_PRODUCTION_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
      null,
  },
  development: {
    url:
      process.env.SUPABASE_DEVELOPMENT_URL ||
      process.env.REACT_APP_SUPABASE_URL ||
      null,
    key:
      process.env.SUPABASE_DEVELOPMENT_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_DEVELOPMENT_ANON_KEY ||
      process.env.REACT_APP_SUPABASE_ANON_KEY ||
      null,
  },
};
const supabaseClients = new Map();

function createHttpError(statusCode, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function normalizeSnapTradeEnv(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!SNAPTRADE_ENV_VALUES.includes(normalized)) {
    throw createHttpError(
      400,
      `Invalid SnapTrade environment: ${value || "(missing)"}`
    );
  }
  return normalized;
}

function getRequestedSnapTradeEnv(req) {
  return normalizeSnapTradeEnv(
    req?.body?.snaptradeEnv ||
      req?.query?.snaptradeEnv ||
      req?.headers?.["x-snaptrade-env"] ||
      DEFAULT_SNAPTRADE_ENV
  );
}

function getSnapTradeEnvironmentConfig(envName) {
  return SNAPTRADE_ENVIRONMENTS[normalizeSnapTradeEnv(envName)];
}

function isSnapTradeEnvironmentConfigured(envName) {
  const config = getSnapTradeEnvironmentConfig(envName);
  return Boolean(config?.clientId && config?.consumerKey);
}

function getSupabaseEnvironmentConfig(envName) {
  return SUPABASE_ENVIRONMENTS[normalizeSnapTradeEnv(envName)];
}

function buildSupabaseClient(envName) {
  const normalizedEnv = normalizeSnapTradeEnv(envName);
  const credentials = getSupabaseEnvironmentConfig(normalizedEnv);

  if (!credentials?.url || !credentials?.key) {
    return null;
  }

  if (supabaseClients.has(normalizedEnv)) {
    return supabaseClients.get(normalizedEnv);
  }

  const client = createClient(credentials.url, credentials.key);
  supabaseClients.set(normalizedEnv, client);
  return client;
}

function getUserSecretKey(envName, userId) {
  return `${envName}:${userId}`;
}

function getStoredUserSecret(envName, userId) {
  return userSecrets.get(getUserSecretKey(envName, userId)) || null;
}

function setStoredUserSecret(envName, userId, userSecret) {
  userSecrets.set(getUserSecretKey(envName, userId), userSecret);
}

function removeStoredUserSecret(envName, userId) {
  userSecrets.delete(getUserSecretKey(envName, userId));
}

function buildSnaptradeContext(envName) {
  const normalizedEnv = normalizeSnapTradeEnv(envName);
  const credentials = getSnapTradeEnvironmentConfig(normalizedEnv);

  if (!credentials?.clientId || !credentials?.consumerKey) {
    throw createHttpError(
      409,
      `${normalizedEnv[0].toUpperCase()}${normalizedEnv.slice(1)} SnapTrade credentials are not configured yet.`
    );
  }

  if (snaptradeContexts.has(normalizedEnv)) {
    return snaptradeContexts.get(normalizedEnv);
  }

  const snaptrade = new Snaptrade({
    clientId: credentials.clientId,
    consumerKey: credentials.consumerKey,
  });

  const generatedConfig = new Configuration({
    consumerKey: credentials.consumerKey,
    basePath: snaptrade.configuration?.basePath,
    baseOptions: snaptrade.configuration?.baseOptions,
  });

  const context = {
    envName: normalizedEnv,
    credentials,
    snaptrade,
    accountInformationApi: new AccountInformationApiGenerated(generatedConfig),
    referenceDataApi: new ReferenceDataApiGenerated(generatedConfig),
  };

  snaptradeContexts.set(normalizedEnv, context);
  return context;
}

function ensureSupabaseConfigured(envName) {
  const client = buildSupabaseClient(envName);
  if (!client) {
    throw createHttpError(
      500,
      `${normalizeSnapTradeEnv(envName)[0].toUpperCase()}${normalizeSnapTradeEnv(envName).slice(1)} Supabase persistence is not configured. Provide environment-specific Supabase credentials for this SnapTrade environment before rotating secrets.`
    );
  }
  return client;
}

async function ensureSupabaseUserExists(envName, userId) {
  const client = ensureSupabaseConfigured(envName);
  const cachedUserSecret = getStoredUserSecret(envName, userId);
  const { data, error } = await client
    .from(SUPABASE_TABLE)
    .select("id, snaptrade_user_id, snaptrade_user_secret")
    .eq("snaptrade_user_id", userId)
    .maybeSingle();

  if (error) {
    throw createHttpError(
      500,
      `Failed to verify Supabase record for ${userId}`,
      error
    );
  }

  if (!data) {
    const seededSecret = cachedUserSecret || crypto.randomUUID();
    const { data: insertedData, error: insertError } = await client
      .from(SUPABASE_TABLE)
      .insert({
        snaptrade_user_id: userId,
        snaptrade_user_secret: seededSecret,
      })
      .select("id, snaptrade_user_id, snaptrade_user_secret")
      .single();

    if (insertError) {
      throw createHttpError(
        500,
        `Failed to create missing Supabase record for ${userId}`,
        insertError
      );
    }

    return {
      ...insertedData,
      seeded: true,
      canAuthenticateWithSnapTrade: Boolean(cachedUserSecret),
    };
  }

  return {
    ...data,
    seeded: false,
    canAuthenticateWithSnapTrade: Boolean(
      cachedUserSecret || data.snaptrade_user_secret
    ),
  };
}

async function updateSupabaseUserSecret(envName, userId, userSecret) {
  const client = ensureSupabaseConfigured(envName);
  const { data, error } = await client
    .from(SUPABASE_TABLE)
    .update({ snaptrade_user_secret: userSecret })
    .eq("snaptrade_user_id", userId)
    .select("snaptrade_user_id, snaptrade_user_secret")
    .maybeSingle();

  if (error) {
    throw createHttpError(
      500,
      `Failed to update Supabase secret for ${userId}`,
      error
    );
  }

  if (!data) {
    throw createHttpError(
      500,
      `Supabase did not return an updated row for ${userId}`
    );
  }

  return data;
}

async function maybeUpsertSupabaseUserSecret(envName, userId, userSecret) {
  const client = buildSupabaseClient(envName);
  if (!client) {
    return null;
  }

  const { error } = await client
    .from(SUPABASE_TABLE)
    .upsert(
      {
        snaptrade_user_id: userId,
        snaptrade_user_secret: userSecret,
      },
      { onConflict: "snaptrade_user_id" }
    );

  if (error) {
    console.error("[SUPABASE] Failed to upsert SnapTrade user secret", {
      userId,
      error,
    });
  }

  return true;
}

// Lightweight readiness probe for local startup orchestration.
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Backend server is running",
  });
});

// Test API credentials without conflating that with server readiness.
app.get("/api/status", async (req, res) => {
  try {
    const envName = getRequestedSnapTradeEnv(req);
    const { snaptrade } = buildSnaptradeContext(envName);
    console.log(`Testing SnapTrade API credentials for ${envName}...`);
    const response = await snaptrade.apiStatus.check();
    console.log("API Status Check Success:", response.data);
    res.json({
      status: "success",
      message: "SnapTrade API credentials are valid",
      snaptradeEnv: envName,
      data: response.data,
    });
  } catch (error) {
    console.error("API Status Check Failed:");
    console.error("Status:", error.response?.status);
    console.error("Error Data:", error.response?.data);
    res.status(500).json({
      status: "error",
      message: "SnapTrade API credentials are invalid or API is down",
      error: error.response?.data || error.message,
    });
  }
});

// Debug endpoint: verifies required config is present WITHOUT returning secrets.
app.get("/api/config-check", (req, res) => {
  const requestedEnv = getRequestedSnapTradeEnv(req);
  res.json({
    snaptradeEnv: requestedEnv,
    availableEnvironments: Object.fromEntries(
      SNAPTRADE_ENV_VALUES.map((envName) => {
        const credentials = getSnapTradeEnvironmentConfig(envName);
        const supabaseConfig = getSupabaseEnvironmentConfig(envName);
        return [
          envName,
          {
            configured: isSnapTradeEnvironmentConfigured(envName),
            clientId: credentials?.clientId || null,
            consumerKey: credentials?.consumerKey || null,
            supabaseUrl: supabaseConfig?.url || null,
            supabaseKey: supabaseConfig?.key || null,
            clientIdMasked: maskLast(credentials?.clientId, 6),
            consumerKeyMasked: maskLast(credentials?.consumerKey, 6),
            supabaseKeyMasked: maskLast(supabaseConfig?.key, 6),
            clientIdFingerprint: fingerprint(credentials?.clientId),
            consumerKeyFingerprint: fingerprint(credentials?.consumerKey),
            supabaseKeyFingerprint: fingerprint(supabaseConfig?.key),
          },
        ];
      })
    ),
  });
});

// List available brokerages (reference data)
app.get("/api/brokerages", async (req, res) => {
  try {
    const envName = getRequestedSnapTradeEnv(req);
    const { referenceDataApi } = buildSnaptradeContext(envName);
    const response = await referenceDataApi.listAllBrokerages();
    res.json(response.data);
  } catch (error) {
    logAxiosLikeError("SnapTrade GET /api/brokerages", error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data || error.message,
    });
  }
});

// List all users (and attach any locally stored userSecret for dev convenience)
app.get("/api/users", async (req, res) => {
  try {
    const envName = getRequestedSnapTradeEnv(req);
    const { snaptrade } = buildSnaptradeContext(envName);
    console.log(`Attempting to list SnapTrade users for ${envName}...`);
    const response = await snaptrade.authentication.listSnapTradeUsers();

    // Transform the response to include user secrets
    const usersWithSecrets = response.data.map((userId) => ({
      userId: userId,
      userSecret: getStoredUserSecret(envName, userId),
    }));

    res.json(usersWithSecrets);
  } catch (error) {
    logAxiosLikeError("SnapTrade /api/users", error);

    res.status(error.response?.status || 500).json({
      error: error.response?.data || error.message,
    });
  }
});

// Register new user
app.post("/api/users", async (req, res) => {
  try {
    const envName = getRequestedSnapTradeEnv(req);
    const { snaptrade } = buildSnaptradeContext(envName);
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    // First check if user already exists
    try {
      const existingUsers = await snaptrade.authentication.listSnapTradeUsers();
      if (existingUsers.data.includes(userId)) {
        return res.status(409).json({ error: "User already exists" });
      }
    } catch (error) {
      console.error("Error checking existing users:", error);
    }

    // Register the new user
    const response = await snaptrade.authentication.registerSnapTradeUser({
      userId: userId,
    });

    // Store the user secret for future use
    setStoredUserSecret(envName, userId, response.data.userSecret);
    await maybeUpsertSupabaseUserSecret(envName, userId, response.data.userSecret);

    res.json({
      ...response.data,
      snaptradeEnv: envName,
    });
  } catch (error) {
    logAxiosLikeError("SnapTrade POST /api/users", error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data || error.message,
    });
  }
});

// Delete user
app.delete("/api/users/:userId", async (req, res) => {
  try {
    const envName = getRequestedSnapTradeEnv(req);
    const { snaptrade } = buildSnaptradeContext(envName);
    const { userId } = req.params;
    const response = await snaptrade.authentication.deleteSnapTradeUser({
      userId: userId,
    });
    removeStoredUserSecret(envName, userId);
    res.json(response.data);
  } catch (error) {
    logAxiosLikeError("SnapTrade DELETE /api/users/:userId", error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data || error.message,
    });
  }
});

// Generate connection with userId and userSecret in URL (for testing only)
app.get("/api/users/:userId/:userSecret/login", async (req, res) => {
  try {
    const envName = getRequestedSnapTradeEnv(req);
    const { snaptrade } = buildSnaptradeContext(envName);
    const { userId, userSecret } = req.params;
    if (!userId || !userSecret) {
      return res
        .status(400)
        .json({ error: "userId and userSecret are required in the URL." });
    }
    // Debug: Log userId and userSecret before making the API call
    console.log("[DEBUG] Attempting loginSnapTradeUser with:");
    console.log("userId:", userId);
    console.log("userSecret:", userSecret);

    const response = await snaptrade.authentication.loginSnapTradeUser({
      userId,
      userSecret,
      customRedirect: `${FRONT_END_URL}/snapTradeRedirect`,
    });
    res.json(response.data);
  } catch (error) {
    logAxiosLikeError("SnapTrade GET /api/users/:userId/:userSecret/login", error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data || error.message,
    });
  }
});

// Generate connection by POSTing userId + userSecret in the body.
// This avoids putting secrets in URLs (history/logs) and allows clients to supply secrets
// stored locally (e.g., browser localStorage) for dev/admin-only usage.
app.post("/api/users/login", async (req, res) => {
  try {
    const envName = getRequestedSnapTradeEnv(req);
    const { snaptrade, credentials } = buildSnaptradeContext(envName);
    const { userId, userSecret } = req.body || {};

    console.log("[LOGIN] Incoming request", {
      snaptradeEnv: envName,
      userId,
      userSecretPresent: Boolean(userSecret),
      userSecretFingerprint: fingerprint(userSecret),
      snaptradeConsumerKeyPresent: Boolean(credentials.consumerKey),
      snaptradeConsumerKeyFingerprint: fingerprint(credentials.consumerKey),
    });

    if (!userId || !userSecret) {
      return res
        .status(400)
        .json({ error: "userId and userSecret are required" });
    }

    const response = await snaptrade.authentication.loginSnapTradeUser({
      userId,
      userSecret,
      customRedirect: `${FRONT_END_URL}/snapTradeRedirect`,
    });

    res.json(response.data);
  } catch (error) {
    logAxiosLikeError("SnapTrade POST /api/users/login", error);
    res.status(error.response?.status || 500).json({
      error: error.response?.data || error.message,
    });
  }
});

// List brokerage accounts connected for a user.
// Body: { userId, userSecret }
app.post("/api/users/accounts", async (req, res) => {
  try {
    const envName = getRequestedSnapTradeEnv(req);
    const { snaptrade, credentials } = buildSnaptradeContext(envName);
    const { userId, userSecret } = req.body || {};

    console.log("[ACCOUNTS] Incoming request", {
      snaptradeEnv: envName,
      userId,
      userSecret: userSecret,
      snaptradeClientId: credentials.clientId,
      snaptradeConsumerKey: credentials.consumerKey
    });


    if (!userId || !userSecret) {
      return res
        .status(400)
        .json({ error: "userId and userSecret are required" });
    }

    console.log("[ACCOUNTS] Calling SnapTrade listUserAccounts...");
    const response = await snaptrade.accountInformation.listUserAccounts({ userId, userSecret });

    console.log("[ACCOUNTS] SnapTrade response summary", {
      status: response?.status,
      statusText: response?.statusText,
      headers: response?.headers,
      summary: summarizeAccountsResponse(response?.data),
    });
    console.log("[ACCOUNTS] SnapTrade response data (preview)", safePreviewJson(response?.data));

    res.json(response.data);
  } catch (error) {
    // Extra verbosity for diagnosing 401s: show where axios tried to call.
    try {
      if (error?.config) {
        console.error("[ACCOUNTS] SnapTrade request config (from error)", {
          method: error.config?.method,
          baseURL: error.config?.baseURL,
          url: error.config?.url,
          timeout: error.config?.timeout,
          headers: error.config?.headers,
          params: error.config?.params,
          data: safeString(error.config?.data),
        });
      }
    } catch {
      // ignore
    }

    logAxiosLikeError("SnapTrade POST /api/users/accounts", error);
    const upstreamStatus = error?.response?.status;
    res.status(upstreamStatus || 500).json({
      error: error?.response?.data || error?.message,
      upstreamStatus: upstreamStatus || null,
      upstreamRequestId: error?.response?.headers?.["x-request-id"] || null,
    });
  }
});

// Get holdings/positions for a specific account.
// Body: { accountId, userId, userSecret }
app.post("/api/users/holdings", async (req, res) => {
  try {
    const envName = getRequestedSnapTradeEnv(req);
    const { snaptrade } = buildSnaptradeContext(envName);
    const { accountId, userId, userSecret } = req.body || {};

    console.log("[HOLDINGS] Incoming request", {
      snaptradeEnv: envName,
      accountId,
      userId,
      userSecret: userSecret
    });

    if (!accountId || !userId || !userSecret) {
      return res
        .status(400)
        .json({ error: "accountId, userId and userSecret are required" });
    }

    console.log("[HOLDINGS] Calling SnapTrade getUserAccountPositions...", {
      accountId,
      userId,
      userSecret
    });

    const response = await snaptrade.accountInformation.getUserAccountPositions({
      accountId,
      userId,
      userSecret,
    });

    res.json(response.data);
  } catch (error) {
    logAxiosLikeError("SnapTrade POST /api/users/holdings", error);
    const upstreamStatus = error?.response?.status;
    res.status(upstreamStatus || 500).json({
      error: error?.response?.data || error?.message,
      upstreamStatus: upstreamStatus || null,
      upstreamRequestId: error?.response?.headers?.["x-request-id"] || null,
    });
  }
});

// Rotate a SnapTrade user secret and persist it to Supabase before returning it to the UI.
app.post("/api/users/rotate-secret", async (req, res) => {
  let rotatedSecret = null;

  try {
    const envName = getRequestedSnapTradeEnv(req);
    const { snaptrade } = buildSnaptradeContext(envName);
    const { userId } = req.body || {};

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const supabaseRecord = await ensureSupabaseUserExists(envName, userId);
    const currentUserSecret =
      getStoredUserSecret(envName, userId) ||
      supabaseRecord?.snaptrade_user_secret ||
      null;

    if (!currentUserSecret || !supabaseRecord?.canAuthenticateWithSnapTrade) {
      throw createHttpError(
        409,
        `Created a Supabase row for ${userId}, but the current SnapTrade user secret is unknown. Rotation cannot proceed until the real existing secret is available.`
      );
    }

    const response = await snaptrade.authentication.resetSnapTradeUserSecret({
      userId,
      userSecret: currentUserSecret,
    });

    rotatedSecret = response?.data?.userSecret;
    if (!rotatedSecret) {
      throw createHttpError(
        502,
        `SnapTrade did not return a rotated secret for ${userId}`
      );
    }

    await updateSupabaseUserSecret(envName, userId, rotatedSecret);
    setStoredUserSecret(envName, userId, rotatedSecret);

    res.json({
      userId,
      userSecret: rotatedSecret,
      snaptradeEnv: envName,
      persistedToSupabase: true,
    });
  } catch (error) {
    if (rotatedSecret) {
      console.error(
        "[ROTATE] SnapTrade returned a rotated secret but persistence failed. Manual recovery may be required.",
        {
          userSecretFingerprint: fingerprint(rotatedSecret),
          details: error?.details || null,
        }
      );
    }

    logAxiosLikeError("SnapTrade POST /api/users/rotate-secret", error);
    res.status(error.statusCode || error.response?.status || 500).json({
      error: error?.details || error?.response?.data || error?.message,
    });
  }
});

// Last-resort Express error handler
app.use((err, req, res, next) => {
  console.error("\n[EXPRESS] Unhandled error:");
  console.error("path:", req?.originalUrl);
  console.error("message:", err?.message);
  if (err?.stack) console.error("stack:\n", err.stack);
  res.status(500).json({ error: err?.message || "Internal Server Error" });
});

// Boot server and run a startup health check for SnapTrade credentials.
const server = app.listen(PORT, () => {
  const actualPort = server.address()?.port;
  const startupEnv = DEFAULT_SNAPTRADE_ENV;
  console.log(`Backend proxy server running on http://localhost:${actualPort}`);
  console.log("Available endpoints:");
  console.log("  GET /api/health - Backend readiness check");
  console.log("  GET /api/status - Test SnapTrade API credentials");
  console.log("  GET /api/users - List all users");
  console.log("  POST /api/users - Register new user");
  console.log("  DELETE /api/users/:userId - Delete a user");
  console.log("  GET /api/users/:userId/login - Generate connection");
  console.log("  POST /api/users/login - Generate connection (body contains userSecret)");
  console.log("  POST /api/users/accounts - List connected accounts (body contains userSecret)");
  console.log("  POST /api/users/holdings - Get holdings across accounts (body contains userSecret)");
  console.log("  POST /api/users/rotate-secret - Rotate user secret and persist it to Supabase");

  console.log(`\n🌐 SnapTrade startup environment: ${startupEnv}`);

  if (!isSnapTradeEnvironmentConfigured(startupEnv)) {
    console.log(
      `⚠️ ${startupEnv} SnapTrade credentials are not configured yet. Startup readiness is still available via /api/health.`
    );
    return;
  }

  const startupContext = buildSnaptradeContext(startupEnv);
  console.log(`🔑 Using SnapTrade Client ID: ${startupContext.credentials.clientId}`);
  console.log("📄 Credentials source: .env file");
  console.log(`🔧 Testing SnapTrade API credentials on startup for ${startupEnv}...`);
  startupContext.snaptrade.apiStatus
    .check()
    .then((response) => {
      console.log("✅ SnapTrade API credentials are VALID");
      console.log("📊 API Status:", response.data);
    })
    .catch((error) => {
      console.log("❌ SnapTrade API credentials are INVALID");
      console.log("🚫 Error:", error.response?.data || error.message);
      console.log("💡 Please check your clientId and consumerKey");
    });
});
