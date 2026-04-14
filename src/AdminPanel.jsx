import React, { useEffect, useState } from "react";
import axios from "axios";
import { normalizeHoldingsResponse } from "./holdings";

const SNAPTRADE_ENV_OPTIONS = [
  { value: "production", label: "Production" },
  { value: "development", label: "Development" },
];

// Use environment variable for API base URL - fail if not set
const API_BASE = process.env.REACT_APP_API_BASE_URL;

if (!API_BASE) {
  throw new Error(
    "REACT_APP_API_BASE_URL environment variable is required but not set in .env file"
  );
}

/**
 * AdminPanel is the main UI for the SnapTrade workflow:
 * 1) Register users (userId + userSecret).
 * 2) Generate connection portal URLs.
 * 3) Fetch connected accounts and holdings.
 */
export default function AdminPanel() {
  const [users, setUsers] = useState([]);
  const [appConfig, setAppConfig] = useState(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState(null);
  const [selectedSnaptradeEnv, setSelectedSnaptradeEnv] = useState("production");
  const [userConnectionStatus, setUserConnectionStatus] = useState({});
  const [statusLoading, setStatusLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [newUserId, setNewUserId] = useState("");
  // Optional override for troubleshooting: when set, API calls use this userId instead
  // of the clicked row's userId.
  const [overrideUserId, setOverrideUserId] = useState("");
  const [registerLoading, setRegisterLoading] = useState(false);
  const [registerError, setRegisterError] = useState(null);
  const [registerSuccess, setRegisterSuccess] = useState(null);
  const [selectedUser, setSelectedUser] = useState(null);
  const [connectionUrl, setConnectionUrl] = useState(null);
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [connectionErrorDetails, setConnectionErrorDetails] = useState(null);
  const [rotatingUserId, setRotatingUserId] = useState(null);
  const [rotationFeedback, setRotationFeedback] = useState(null);

  const [brokerages, setBrokerages] = useState([]);
  const [brokeragesLoading, setBrokeragesLoading] = useState(false);
  const [brokeragesError, setBrokeragesError] = useState(null);
  const [userAccounts, setUserAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState(null);
  // Dummy connected-state per userId -> array of brokerage ids
  const [connectedBrokeragesByUser, setConnectedBrokeragesByUser] = useState({});
  const [selectedBrokerageId, setSelectedBrokerageId] = useState(null);

  const [holdingsUserId, setHoldingsUserId] = useState(null);
  const [holdingsLoading, setHoldingsLoading] = useState(false);
  const [holdingsError, setHoldingsError] = useState(null);
  const [holdingsErrorDetails, setHoldingsErrorDetails] = useState(null);
  const [holdingsData, setHoldingsData] = useState(null);

  const selectedEnvironmentConfig =
    appConfig?.availableEnvironments?.[selectedSnaptradeEnv] || null;

  const appMode = selectedSnaptradeEnv === "production" ? "Production" : "Development";

  /**
   * Return the first non-empty string from a list of candidates.
   * If a candidate is an object, try common string fields on it.
   */
  const firstString = (...candidates) => {
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();

      // Sometimes ticker-like values are nested in objects.
      if (c && typeof c === "object") {
        const nested =
          c.symbol ||
          c.ticker ||
          c.code ||
          c.name ||
          c.id;
        if (typeof nested === "string" && nested.trim()) return nested.trim();
      }
    }
    return "";
  };

  /**
   * Extract a human-readable ticker symbol from a holdings position.
   * The SnapTrade response shape varies by connector, so we check many paths.
   */
  const formatTicker = (position) => {
    // Prefer an actual ticker symbol (e.g., SSTK) over any internal ids.
    // SnapTrade position shapes vary by connector; these cover the common cases.
    return firstString(
      position?.ticker,
      position?.symbol?.symbol,
      position?.symbol?.ticker,
      // Some connectors nest the universal symbol another level deep: symbol.symbol.symbol
      position?.symbol?.symbol?.symbol,
      position?.symbol?.symbol?.ticker,
      position?.universalSymbol?.symbol,
      position?.universalSymbol?.ticker,
      position?.universal_symbol?.symbol,
      position?.universal_symbol?.ticker,
      position?.instrument?.symbol,
      position?.instrument?.ticker,
      position?.security?.symbol,
      position?.security?.ticker,
      // Some responses nest universal symbol under the instrument
      position?.instrument?.universalSymbol?.symbol,
      position?.instrument?.universal_symbol?.symbol,
      // Last resort: only use position.symbol if it's already a string
      typeof position?.symbol === "string" ? position.symbol : ""
    );
  };

  /**
   * Extract the security/company name from a holdings position.
   * This is used for the "Name" column in the holdings table.
   */
  const formatSecurityName = (position) => {
    return firstString(
      // Some APIs return these at the top level
      position?.name,
      position?.description,
      position?.securityName,

      // SnapTrade-ish common nesting
      position?.symbol?.description,
      position?.symbol?.name,
      position?.symbol?.companyName,

      // Specifically observed shape: position.symbol.symbol.description
      position?.symbol?.symbol?.description,
      position?.symbol?.symbol?.name,
      position?.symbol?.symbol?.companyName,

      position?.universalSymbol?.description,
      position?.universalSymbol?.name,
      position?.universalSymbol?.companyName,
      position?.universal_symbol?.description,
      position?.universal_symbol?.name,

      position?.instrument?.name,
      position?.instrument?.description,
      position?.instrument?.securityName,
      position?.instrument?.symbol?.description,
      position?.instrument?.universalSymbol?.description,
      position?.instrument?.universal_symbol?.description,

      position?.security?.name,
      position?.security?.description,
      position?.security?.securityName,
      position?.security?.companyName
    );
  };

  // ---- Local secret storage (dev/admin-only) ----
  // We store userSecrets in localStorage so Generate Portal still works after backend restarts.
  // Shape: { production: { [userId]: userSecret }, development: { [userId]: userSecret } }
  const USER_SECRETS_KEY = "snaptrade_userSecrets_v1";

  const normalizeLocalSecrets = (value) => {
    if (!value || typeof value !== "object") {
      return { production: {}, development: {} };
    }

    const hasScopedEnvs = SNAPTRADE_ENV_OPTIONS.some(
      ({ value: envName }) => value?.[envName] && typeof value[envName] === "object"
    );

    if (hasScopedEnvs) {
      return {
        production: value.production && typeof value.production === "object" ? value.production : {},
        development:
          value.development && typeof value.development === "object" ? value.development : {},
      };
    }

    return {
      production: value,
      development: {},
    };
  };

  /**
   * Load locally stored user secrets from browser storage.
   * This keeps the admin workflow usable after backend restarts.
   */
  const loadLocalSecrets = () => {
    try {
      const raw = localStorage.getItem(USER_SECRETS_KEY);
      if (!raw) return { production: {}, development: {} };
      const parsed = JSON.parse(raw);
      return normalizeLocalSecrets(parsed);
    } catch {
      return { production: {}, development: {} };
    }
  };

  /**
   * Save a userSecret to localStorage keyed by userId.
   */
  const saveLocalSecret = (envName, userId, userSecret) => {
    try {
      const normalizedEnv = envName === "development" ? "development" : "production";
      const current = loadLocalSecrets();
      const next = {
        ...current,
        [normalizedEnv]: {
          ...(current?.[normalizedEnv] || {}),
          [userId]: userSecret,
        },
      };
      localStorage.setItem(USER_SECRETS_KEY, JSON.stringify(next));
    } catch {
      // ignore localStorage failures
    }
  };

  /**
   * Read a userSecret from localStorage (if present).
   */
  const getLocalSecret = (envName, userId) => {
    const map = loadLocalSecrets();
    const normalizedEnv = envName === "development" ? "development" : "production";
    return map?.[normalizedEnv]?.[userId] || null;
  };

  /**
   * Returns the userId used for API calls. Can be overridden for debugging.
   */
  const getEffectiveUserId = (userId) => {
    const trimmed = (overrideUserId || "").trim();
    return trimmed || userId;
  };

  // Secret lookup should always use the email-based userId (the row userId), even if
  // we override the outbound userId used for SnapTrade calls.
  const getSecretUserId = (rowUserId) => rowUserId;

  const getEnvironmentLabel = (envName) =>
    SNAPTRADE_ENV_OPTIONS.find((option) => option.value === envName)?.label ||
    envName;

  const fetchAppConfig = async (envName = selectedSnaptradeEnv) => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const res = await axios.get(`${API_BASE}/config-check`, {
        params: { _ts: Date.now(), snaptradeEnv: envName },
      });
      setAppConfig(res.data || null);
      return res.data || null;
    } catch (err) {
      setConfigError(
        err.response?.data?.error || err.message || "Failed to load app configuration"
      );
      setAppConfig(null);
      return null;
    } finally {
      setConfigLoading(false);
    }
  };

  const buildStatusErrorMessage = (err) => {
    const rawMessage =
      err?.response?.data?.error ||
      err?.response?.data?.message ||
      err?.message ||
      "Unable to determine connection status";

    if (rawMessage === "User secret not found locally. Please re-register this user.") {
      return "No local user secret is stored in this browser yet.";
    }

    return rawMessage;
  };

  const fetchUserConnectionStatuses = async (
    userList,
    envName = selectedSnaptradeEnv
  ) => {
    if (!Array.isArray(userList) || userList.length === 0) {
      setUserConnectionStatus({});
      return;
    }

    setStatusLoading(true);
    setUserConnectionStatus(
      Object.fromEntries(
        userList.map((user) => [
          user.userId,
          {
            state: "checking",
            label: "Checking",
            detail: "Checking connected accounts...",
            accountCount: 0,
          },
        ])
      )
    );

    const nextStatuses = await Promise.all(
      userList.map(async (user) => {
        const userSecret = user.userSecret || getLocalSecret(envName, user.userId);

        if (!userSecret) {
          return [
            user.userId,
            {
              state: "disconnected",
              label: "Disconnected",
              detail:
                "Not available (re-register) means this browser does not have the SnapTrade user secret cached for this user, so portal generation and account checks cannot run until you re-register here.",
              accountCount: 0,
              needsReregistration: true,
            },
          ];
        }

        try {
          const res = await axios.post(`${API_BASE}/users/accounts`, {
            userId: user.userId,
            userSecret,
            snaptradeEnv: envName,
          });

          const accounts = Array.isArray(res.data) ? res.data : [];

          if (accounts.length > 0) {
            return [
              user.userId,
              {
                state: "connected",
                label: "Connected",
                detail: `${accounts.length} connected account${
                  accounts.length === 1 ? "" : "s"
                } found.`,
                accountCount: accounts.length,
                needsReregistration: false,
              },
            ];
          }

          return [
            user.userId,
            {
              state: "disconnected",
              label: "Disconnected",
              detail: "User exists in SnapTrade, but no connected brokerage accounts were returned yet.",
              accountCount: 0,
              needsReregistration: false,
            },
          ];
        } catch (err) {
          return [
            user.userId,
            {
              state: "disconnected",
              label: "Disconnected",
              detail: buildStatusErrorMessage(err),
              accountCount: 0,
              needsReregistration: false,
            },
          ];
        }
      })
    );

    setUserConnectionStatus(Object.fromEntries(nextStatuses));
    setStatusLoading(false);
  };

  const getUserStatus = (user) => {
    const status = userConnectionStatus?.[user.userId];
    if (status) return status;

    return {
      state: "checking",
      label: "Checking",
      detail: "Checking connected accounts...",
      accountCount: 0,
      needsReregistration: !user.userSecret,
    };
  };

  const connectedUsers = users.filter(
    (user) => getUserStatus(user).state === "connected"
  );

  const disconnectedUsers = users.filter(
    (user) => getUserStatus(user).state !== "connected"
  );

  const renderUserTable = (userList) => {
    if (!userList.length) {
      return null;
    }

    return (
      <table className="min-w-full bg-white border border-gray-300">
        <thead>
          <tr>
            <th className="border px-4 py-2">User ID</th>
            <th className="border px-4 py-2">Status</th>
            <th className="border px-4 py-2">User Secret</th>
            <th className="border px-4 py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {userList.map((user) => {
            const status = getUserStatus(user);
            const isSelected = selectedUser === user.userId;
            const statusClasses =
              status.state === "connected"
                ? "bg-green-100 text-green-800"
                : status.state === "checking"
                ? "bg-amber-100 text-amber-800"
                : "bg-slate-100 text-slate-700";

            return (
              <tr key={user.userId} className={isSelected ? "bg-blue-50" : ""}>
                <td className="border px-4 py-2 align-top">{user.userId}</td>
                <td className="border px-4 py-2 align-top">
                  <div className="space-y-1">
                    <span
                      className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${statusClasses}`}
                    >
                      {status.label}
                    </span>
                    <div className="text-xs text-gray-600">{status.detail}</div>
                  </div>
                </td>
                <td className="border px-4 py-2 align-top">
                  {user.userSecret ? (
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs bg-gray-100 px-2 py-1 rounded">
                        {user.userSecret.substring(0, 8)}...
                      </span>
                      <button
                        onClick={() => navigator.clipboard.writeText(user.userSecret)}
                        className="bg-gray-500 text-white px-2 py-1 rounded text-xs hover:bg-gray-600"
                        title="Copy full secret"
                      >
                        Copy
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <span className="text-red-500 text-sm">Not available (re-register)</span>
                      <div className="text-xs text-gray-600">
                        This browser is missing the userSecret for this SnapTrade user.
                      </div>
                    </div>
                  )}
                </td>
                <td className="border px-4 py-2 align-top">
                  <div className="flex flex-col items-start gap-2">
                  <button
                    className="bg-blue-500 text-white px-3 py-1 rounded hover:bg-blue-600 disabled:bg-gray-400"
                    onClick={() => generateConnection(user.userId)}
                    disabled={
                      (connectionLoading && selectedUser === user.userId) ||
                      !user.userSecret
                    }
                  >
                    {connectionLoading && selectedUser === user.userId
                      ? "Generating..."
                      : "Generate Portal"}
                  </button>
                  <button
                    className="bg-amber-500 text-white px-3 py-1 rounded hover:bg-amber-600 disabled:bg-gray-400"
                    onClick={() => rotateUserSecret(user.userId)}
                    disabled={rotatingUserId === user.userId || !selectedEnvironmentConfig?.configured}
                    title="Rotates the secret for the SnapTrade user. Use this only if the userSecret is believed to be compromised."
                  >
                    {rotatingUserId === user.userId ? "Rotating..." : "Rotate User Secret"}
                  </button>
                  <button
                    className="bg-red-500 text-white px-3 py-1 rounded hover:bg-red-600"
                    onClick={() => deleteUser(user.userId)}
                  >
                    Delete
                  </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  };

  /**
   * Fetch user list from the backend and merge in any locally stored secrets
   * so the UI can continue to generate portals without re-registering.
   */
  const fetchUsers = async (envName = selectedSnaptradeEnv) => {
    setLoading(true);
    setError(null);
    try {
      // Bypass any caches (browser/proxy/axios) to ensure we always show server truth.
      const res = await axios.get(`${API_BASE}/users`, {
        params: { _ts: Date.now(), snaptradeEnv: envName },
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        },
      });
      const localSecrets = loadLocalSecrets();
      // Always show the most up-to-date server list of users, but enrich with any locally stored secrets.
      const merged = (res.data || []).map((u) => ({
        ...u,
        userSecret: u.userSecret || localSecrets?.[envName]?.[u.userId] || null,
      }));

      setUsers(merged);
      setRotationFeedback(null);
      fetchUserConnectionStatuses(merged, envName);
    } catch (err) {
      console.error("API Error:", err);

      // Check if it's a CORS error
      if (err.code === "ERR_NETWORK" || err.message === "Network Error") {
        setError(
          `Connection Error: Make sure the backend server is running on ${API_BASE.replace(
            "/api",
            ""
          )}`
        );
      } else {
        const errorMessage =
          err.response?.data?.error ||
          err.response?.data?.message ||
          err.response?.statusText ||
          err.message ||
          "Failed to fetch users";
        setError(
          `Error: ${errorMessage} (Status: ${
            err.response?.status || "Unknown"
          })`
        );
      }
      setUsers([]);
      setUserConnectionStatus({});
    }
    setLoading(false);
  };

  const refreshSelectedEnvironment = async (envName = selectedSnaptradeEnv) => {
    setSelectedUser(null);
    setConnectionUrl(null);
    setConnectionErrorDetails(null);
    setUserAccounts([]);
    setAccountsError(null);
    setSelectedBrokerageId(null);
    setHoldingsUserId(null);
    setHoldingsData(null);
    setHoldingsError(null);
    setHoldingsErrorDetails(null);

    const nextConfig = await fetchAppConfig(envName);
    if (!nextConfig?.availableEnvironments?.[envName]?.configured) {
      setUsers([]);
      setUserConnectionStatus({});
      setError(`${getEnvironmentLabel(envName)} SnapTrade credentials are not configured yet.`);
      return;
    }

    await fetchUsers(envName);
  };

  /**
   * Load all brokerages (reference data). Used by earlier UX flows.
   */
  const fetchBrokerages = async () => {
    setBrokeragesLoading(true);
    setBrokeragesError(null);
    try {
      const res = await axios.get(`${API_BASE}/brokerages`, {
        params: { _ts: Date.now(), snaptradeEnv: selectedSnaptradeEnv },
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        },
      });

      setBrokerages(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Brokerages Error:", err);
      setBrokeragesError(
        err.response?.data?.error || err.message || "Failed to load brokerages"
      );
    }
    setBrokeragesLoading(false);
  };

  /**
   * Fetch the user's connected accounts from SnapTrade and store them
   * for the "Your Brokerages" list.
   */
  const fetchUserAccountsForBrokerages = async (userId) => {
    const effectiveUserId = getEffectiveUserId(userId);
    if (!effectiveUserId) return;
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const userSecret = getLocalSecret(selectedSnaptradeEnv, getSecretUserId(userId));
      if (!userSecret) {
        setUserAccounts([]);
        setAccountsError(
          `User secret not found locally for ${getSecretUserId(userId)}. Please re-register this user.`
        );
        setAccountsLoading(false);
        return;
      }

      const res = await axios.post(`${API_BASE}/users/accounts`, {
        userId: effectiveUserId,
        userSecret,
        snaptradeEnv: selectedSnaptradeEnv,
      });
      setUserAccounts(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Accounts Error:", err);
      setAccountsError(
        err.response?.data?.error || err.message || "Failed to load user accounts"
      );
      setUserAccounts([]);
    }
    setAccountsLoading(false);
  };

  /**
   * Request a connection portal link for the selected user.
   * Uses the local userSecret and stores the returned redirect URL.
   */
  const generateConnection = async (userId) => {
    setRotationFeedback(null);
    setConnectionLoading(true);
    const effectiveUserId = getEffectiveUserId(userId);
    setSelectedUser(effectiveUserId);
    setConnectionUrl(null);
    setConnectionErrorDetails(null);

    try {
      const userSecret = getLocalSecret(selectedSnaptradeEnv, getSecretUserId(userId));
      if (!userSecret) {
        alert("User secret not found locally. Please re-register this user.");
        setSelectedUser(null);
        setConnectionLoading(false);
        return;
      }

      // Send secret in POST body (not URL) to avoid browser history/logging issues.
      const res = await axios.post(`${API_BASE}/users/login`, {
        userId: effectiveUserId,
        userSecret,
        snaptradeEnv: selectedSnaptradeEnv,
      });
      setConnectionUrl(res.data.redirectURI);

    // After portal is generated, load the user's connected accounts so we can show only the brokerages the user has.
    fetchUserAccountsForBrokerages(effectiveUserId);

      // Automatically open in new tab
      // window.open(res.data.redirectURI, "_blank");
    } catch (err) {
      console.error("Connection Error:", err);

      setConnectionErrorDetails({
        message: err?.message,
        code: err?.code,
        status: err?.response?.status,
        statusText: err?.response?.statusText,
        data: err?.response?.data,
        url: err?.config?.url,
        method: err?.config?.method,
      });

      let errorMessage = "Failed to generate connection";
      if (err.response?.status === 404) {
        errorMessage = "User secret not found. Please re-register this user.";
      } else if (err.response?.data?.error) {
        errorMessage = err.response.data.error;
      }

      alert(errorMessage);
      setSelectedUser(null);
    }
    setConnectionLoading(false);
  };

  /**
   * Remove a user from SnapTrade and refresh the local list.
   */
  const deleteUser = async (userId) => {
    if (!window.confirm("Are you sure you want to delete this user?")) return;
    try {
      await axios.delete(`${API_BASE}/users/${userId}`, {
        params: { snaptradeEnv: selectedSnaptradeEnv },
      });
      alert(`Deleted ${userId}`);
      fetchUsers();
    } catch (err) {
      alert(`Failed to delete ${userId}`);
    }
  };

  const rotateUserSecret = async (userId) => {
    setRotationFeedback(null);
    setRotatingUserId(userId);

    try {
      const res = await axios.post(`${API_BASE}/users/rotate-secret`, {
        userId,
        snaptradeEnv: selectedSnaptradeEnv,
      });

      if (res.data?.userSecret) {
        saveLocalSecret(selectedSnaptradeEnv, userId, res.data.userSecret);
      }

      setRotationFeedback({
        type: "success",
        message: `Rotated the userSecret for ${userId} in ${getEnvironmentLabel(selectedSnaptradeEnv)} and persisted it to Supabase.`,
      });

      await fetchUsers(selectedSnaptradeEnv);
    } catch (err) {
      const errorMessage =
        err.response?.data?.error ||
        err.response?.data?.message ||
        err.message ||
        "Failed to rotate user secret";

      setRotationFeedback({
        type: "error",
        message: errorMessage,
      });
    }

    setRotatingUserId(null);
  };

  /**
   * Register a new user with SnapTrade and store the userSecret locally
   * so the admin UI can generate portals without re-registering.
   */
  const registerUser = async (e) => {
    e.preventDefault();
    if (!newUserId.trim()) {
      setRegisterError("User ID is required");
      return;
    }

    setRegisterLoading(true);
    setRegisterError(null);
    setRegisterSuccess(null);

    try {
      const res = await axios.post(`${API_BASE}/users`, {
        userId: newUserId.trim(),
        snaptradeEnv: selectedSnaptradeEnv,
      });

      // Persist userSecret locally so Generate Portal works even after backend restarts.
      if (res.data?.userId && res.data?.userSecret) {
        saveLocalSecret(selectedSnaptradeEnv, res.data.userId, res.data.userSecret);
      }

      setRegisterSuccess(
        `User registered successfully in ${getEnvironmentLabel(selectedSnaptradeEnv)}. User ID: ${res.data.userId}`
      );
      setNewUserId("");

      // Refresh the users list
      fetchUsers(selectedSnaptradeEnv);
    } catch (err) {
      console.error("Register Error:", err);

      if (err.response?.status === 409) {
        setRegisterError("User already exists");
      } else {
        const errorMessage =
          err.response?.data?.error ||
          err.response?.data?.message ||
          err.response?.statusText ||
          err.message ||
          "Failed to register user";
        setRegisterError(errorMessage);
      }
    }
    setRegisterLoading(false);
  };

  useEffect(() => {
    refreshSelectedEnvironment(selectedSnaptradeEnv);
  }, [selectedSnaptradeEnv]);

  /**
   * Fetch holdings for a specific account and render them in the UI.
   * Uses the local userSecret but allows a debug override for userId.
   */
  const viewHoldings = async (userId, accountId = null) => {
    const effectiveUserId = getEffectiveUserId(userId);
    setHoldingsUserId(effectiveUserId);
    setHoldingsLoading(true);
    setHoldingsError(null);
    setHoldingsErrorDetails(null);
    setHoldingsData(null);
    setSelectedBrokerageId(accountId);
    try {
      // We need: userSecret from the email userId, but request userId can be overridden.
      const userSecret = getLocalSecret(
        selectedSnaptradeEnv,
        getSecretUserId(userId)
      );
      if (!userSecret) {
        const err = new Error(
          `User secret not found locally for ${getSecretUserId(userId)}. Please re-register this user.`
        );
        err.code = "NO_LOCAL_SECRET";
        throw err;
      }

      if (!accountId) {
        const err = new Error("Missing accountId for holdings request. Refresh accounts and try again.");
        err.code = "NO_ACCOUNT_ID";
        throw err;
      }
      const res = await axios.post(`${API_BASE}/users/holdings`, {
        accountId,
        userId: effectiveUserId,
        userSecret,
        snaptradeEnv: selectedSnaptradeEnv,
      });
      const data = res.data;
      setHoldingsData(data);
    } catch (e) {
      const message = e?.message || "Failed to fetch holdings";
      setHoldingsError(message);

      // Capture verbose details for copy/paste.
      const details = {
        message,
        code: e?.code,
        status: e?.response?.status,
        statusText: e?.response?.statusText,
        data: e?.response?.data,
        url: e?.config?.url,
        method: e?.config?.method,
      };
      setHoldingsErrorDetails(details);
    }
    setHoldingsLoading(false);
  };

  /**
   * Check if the given account is marked as connected in the local UI state.
   */
  const isBrokerageConnected = (userId, brokerageId) => {
    const arr = connectedBrokeragesByUser?.[userId] || [];
    return arr.includes(brokerageId);
  };

  /**
   * Mark an account as connected locally and immediately load holdings.
   * This is a UI-only flow for the demo/UX requirement.
   */
  const connectBrokerage = async (userId, accountId) => {
    const effectiveUserId = getEffectiveUserId(userId);
    // Dummy connect: store the connected state locally and auto-call holdings.
    setConnectedBrokeragesByUser((prev) => {
      const existing = prev?.[effectiveUserId] || [];
      if (existing.includes(accountId)) return prev;
      return { ...prev, [effectiveUserId]: [...existing, accountId] };
    });

    // Requirement: once connected, auto-call View Holdings.
    await viewHoldings(userId, accountId);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-bold">Admin Panel - SnapTrade</h1>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className="inline-flex rounded-full bg-slate-900 px-2 py-1 font-semibold text-white">
              SnapTrade {appMode}
            </span>
            {statusLoading && (
              <span className="inline-flex rounded-full bg-amber-100 px-2 py-1 font-semibold text-amber-800">
                Checking user connection states...
              </span>
            )}
          </div>
        </div>

        <div className="text-right">
          <label className="block text-xs font-medium text-gray-700">
            Override userId (debug)
          </label>
          <input
            type="text"
            value={overrideUserId}
            onChange={(e) => setOverrideUserId(e.target.value)}
            placeholder="(optional) user@example.com"
            className="mt-1 w-72 px-2 py-1 border border-gray-300 rounded text-sm"
          />
          <div className="mt-1 text-xs text-gray-600">
            When set, calls use this userId instead of the selected row.
          </div>
        </div>
      </div>

      {/* Debug info */}
      <div className="mb-4 p-3 bg-gray-100 rounded text-sm">
        <p>
          <strong>API URL:</strong> {API_BASE}/users
        </p>
        <p>
          <strong>Backend Proxy:</strong> {API_BASE.replace("/api", "")}
        </p>
        <p>
          <strong>Source:</strong> Environment Variable (REACT_APP_API_BASE_URL)
        </p>
      </div>

      <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Environment Header</h2>
            <p className="text-sm text-slate-600">
              Select which SnapTrade environment the admin UI should use, then review the SnapTrade and Supabase credentials for that environment.
            </p>
          </div>
          <button
            className="rounded bg-slate-900 px-3 py-1 text-sm text-white hover:bg-slate-800 disabled:bg-slate-400"
            onClick={() => refreshSelectedEnvironment(selectedSnaptradeEnv)}
            disabled={configLoading}
          >
            {configLoading ? "Refreshing..." : "Refresh Header Info"}
          </button>
        </div>

        {configError && <p className="mt-3 text-sm text-red-600">{configError}</p>}

        <div className="mt-4 flex flex-wrap gap-2">
          {SNAPTRADE_ENV_OPTIONS.map((option) => {
            const envConfig = appConfig?.availableEnvironments?.[option.value];
            const isActive = selectedSnaptradeEnv === option.value;

            return (
              <button
                key={option.value}
                type="button"
                className={`rounded-full px-3 py-1 text-sm font-semibold ${
                  isActive
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-700 border border-slate-300"
                }`}
                onClick={() => setSelectedSnaptradeEnv(option.value)}
              >
                {option.label}
                {!envConfig?.configured ? " (not configured)" : ""}
              </button>
            );
          })}
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-5">
          <div className="rounded border bg-white p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              SnapTrade Environment
            </div>
            <div className="mt-1 text-sm font-semibold text-slate-900">{appMode}</div>
            <div className="mt-1 text-xs text-slate-600">
              {selectedEnvironmentConfig?.configured
                ? `${getEnvironmentLabel(selectedSnaptradeEnv)} credentials are configured.`
                : `${getEnvironmentLabel(selectedSnaptradeEnv)} credentials are not configured yet.`}
            </div>
          </div>
          <div className="rounded border bg-white p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Client ID
            </div>
            <div className="mt-1 break-all font-mono text-sm text-slate-900">
              {selectedEnvironmentConfig?.clientId || "Not configured"}
            </div>
          </div>
          <div className="rounded border bg-white p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Secret / Consumer Key
            </div>
            <div className="mt-1 break-all font-mono text-sm text-slate-900">
              {selectedEnvironmentConfig?.consumerKey || "Not configured"}
            </div>
          </div>
          <div className="rounded border bg-white p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Supabase URL
            </div>
            <div className="mt-1 break-all font-mono text-sm text-slate-900">
              {selectedEnvironmentConfig?.supabaseUrl || "Not configured"}
            </div>
          </div>
          <div className="rounded border bg-white p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Supabase Key
            </div>
            <div className="mt-1 break-all font-mono text-sm text-slate-900">
              {selectedEnvironmentConfig?.supabaseKey || "Not configured"}
            </div>
          </div>
        </div>
      </div>

      {rotationFeedback && (
        <div
          className={`mb-6 rounded-lg border p-4 text-sm ${
            rotationFeedback.type === "success"
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {rotationFeedback.message}
        </div>
      )}

      <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">What “Not available (re-register)” means</p>
        <p className="mt-1">
          SnapTrade knows the user exists, but this browser does not currently have that user’s local userSecret cached. Without that secret, the UI cannot generate a portal or fetch accounts for that user. Re-registering the user in this admin panel stores a fresh secret locally for this browser session.
        </p>
      </div>

      {/* Broker list (dummy connect) */}
      {selectedUser && (
        <div className="mb-6 p-4 border rounded">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Your Brokerages</h2>
            <button
              className="px-3 py-1 bg-gray-200 rounded hover:bg-gray-300 disabled:opacity-50"
              onClick={() => fetchUserAccountsForBrokerages(selectedUser)}
              disabled={accountsLoading}
            >
              {accountsLoading ? "Loading..." : "Refresh"}
            </button>
          </div>

          <div className="mt-1 text-xs text-gray-600">
            This list is derived from the user’s connected accounts (not all possible brokerages).
          </div>

          {accountsError && (
            <div className="mt-2 text-red-600 text-sm">{accountsError}</div>
          )}

          {!accountsLoading && userAccounts.length === 0 && (
            <div className="mt-2 text-sm text-gray-600">
              No connected accounts were found for this user yet.
            </div>
          )}

          <ul className="mt-3 space-y-2">
            {userAccounts.map((acct, idx) => {
              // For holdings-by-account we need a concrete accountId.
              const accountId = acct?.id || acct?.accountId || acct?.brokerageAccountId || null;
              const rowKey = accountId || String(idx);

              const brokerageName =
                acct?.institutionName ||
                acct?.brokerage?.name ||
                acct?.brokerageName ||
                acct?.name ||
                "Account";

              const connected = isBrokerageConnected(selectedUser, accountId);

              return (
                <li key={String(rowKey)} className="p-3 border rounded">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{brokerageName}</div>
                      <div className="text-xs text-gray-600 truncate">
                        accountId: {accountId ? String(accountId) : "(missing)"}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        className={`px-3 py-1 rounded ${
                          connected
                            ? "bg-green-600 text-white"
                            : "bg-blue-600 text-white hover:bg-blue-700"
                        } disabled:opacity-50`}
                        onClick={() => connectBrokerage(selectedUser, accountId)}
                        disabled={holdingsLoading || connectionLoading || !accountId}
                      >
                        {connected ? "Connected" : "Connect Brokerage"}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {selectedBrokerageId && (
            <div className="mt-3 text-xs text-gray-700">
              Holdings scope (dummy): brokerage id <strong>{String(selectedBrokerageId)}</strong>
            </div>
          )}
        </div>
      )}

      {/* Refresh button */}
      <button
        className="mb-4 bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600"
        onClick={() => refreshSelectedEnvironment(selectedSnaptradeEnv)}
        disabled={loading}
      >
        {loading ? "Loading..." : "Refresh Users"}
      </button>

      {/* Register New User Form */}
      <div className="mb-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
        <h2 className="text-lg font-semibold mb-3 text-blue-800">
          Register New User
        </h2>
        <form onSubmit={registerUser} className="flex flex-col gap-3">
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label
                htmlFor="newUserId"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                User ID (Email or Unique ID)
              </label>
              <input
                type="text"
                id="newUserId"
                value={newUserId}
                onChange={(e) => setNewUserId(e.target.value)}
                placeholder="Enter user ID (e.g., user@example.com)"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                disabled={registerLoading}
              />
            </div>
            <button
              type="submit"
              disabled={registerLoading || !newUserId.trim()}
              className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {registerLoading ? "Registering..." : "Register User"}
            </button>
          </div>

          {registerError && (
            <p className="text-red-600 text-sm">{registerError}</p>
          )}

          {registerSuccess && (
            <p className="text-green-600 text-sm">{registerSuccess}</p>
          )}
        </form>
      </div>

      {loading && <p>Loading users...</p>}
      {error && <p className="text-red-600">{error}</p>}

      {/* Connection Portal URL Display */}
      {connectionUrl && selectedUser && (
        <div className="mb-6 p-4 bg-green-50 rounded-lg border border-green-200">
          <h3 className="text-lg font-semibold mb-3 text-green-800">
            Connection Portal Generated for: {selectedUser}
          </h3>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Portal URL (expires in 5 minutes):
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={connectionUrl}
                  readOnly
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-md bg-gray-50 text-sm"
                />
                <button
                  onClick={() => navigator.clipboard.writeText(connectionUrl)}
                  className="bg-green-500 text-white px-3 py-2 rounded hover:bg-green-600 text-sm"
                >
                  Copy
                </button>
                <button
                  onClick={() => window.open(connectionUrl, "_blank")}
                  className="bg-blue-500 text-white px-3 py-2 rounded hover:bg-blue-600 text-sm"
                >
                  Open
                </button>
              </div>
            </div>
            <button
              onClick={() => {
                setConnectionUrl(null);
                setSelectedUser(null);
              }}
              className="text-sm text-gray-600 hover:text-gray-800"
            >
              ✕ Close
            </button>
          </div>
        </div>
      )}

      {/* Connection error details (copy/paste) */}
      {!connectionUrl && connectionErrorDetails && (
        <div className="mb-6 p-4 bg-red-50 rounded-lg border border-red-200">
          <h3 className="text-lg font-semibold text-red-800">Connection Error</h3>
          <p className="text-sm text-red-700">
            Expand to copy/paste the full details.
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer text-sm text-red-800">
              Show error details
            </summary>
            <pre className="mt-2 text-xs bg-white p-3 rounded border overflow-auto">
              {JSON.stringify(connectionErrorDetails, null, 2)}
            </pre>
          </details>
        </div>
      )}

      {/* Holdings Display */}
      {holdingsUserId && (
        <div className="mb-6 p-4 bg-purple-50 rounded-lg border border-purple-200">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-purple-800">
                Holdings for: {holdingsUserId}
              </h3>
              <p className="text-sm text-purple-700">
                Data is fetched live from the server each time holdings are requested.
              </p>
            </div>
            <button
              onClick={() => {
                setHoldingsUserId(null);
                setHoldingsLoading(false);
                setHoldingsError(null);
                setHoldingsErrorDetails(null);
                setHoldingsData(null);
              }}
              className="text-sm text-gray-600 hover:text-gray-800"
            >
              ✕ Close
            </button>
          </div>

          {holdingsLoading && <p className="mt-3">Loading holdings...</p>}
          {holdingsError && (
            <div className="mt-3">
              <p className="text-red-600">Error: {holdingsError}</p>
              {holdingsErrorDetails && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-red-700">
                    Show error details (copy/paste)
                  </summary>
                  <pre className="mt-2 text-xs bg-white p-3 rounded border overflow-auto">
                    {JSON.stringify(holdingsErrorDetails, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}

          {!holdingsLoading && !holdingsError && holdingsData && (() => {
            const normalized = normalizeHoldingsResponse(holdingsData);
            const positions = normalized.positions;

            // If we got data back but our normalizer didn't find an array, show the raw response
            // so it's obvious why the table is empty.
            if (!Array.isArray(positions)) {
              return (
                <div className="mt-3">
                  <p className="text-sm text-gray-700">
                    Holdings response received, but it wasn’t recognized as a list of positions.
                    Expand the raw response to see the shape.
                  </p>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm text-purple-800">
                      Show raw response
                    </summary>
                    <pre className="mt-2 text-xs bg-white p-3 rounded border overflow-auto">
                      {JSON.stringify(normalized.raw ?? holdingsData, null, 2)}
                    </pre>
                  </details>
                </div>
              );
            }

            if (!positions.length) {
              return (
                <div className="mt-3">
                  <p className="text-sm text-gray-700">
                    No positions returned. This usually means you haven’t connected an account for this user yet,
                    or the connected account has no holdings.
                  </p>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm text-purple-800">
                      Show raw response
                    </summary>
                    <pre className="mt-2 text-xs bg-white p-3 rounded border overflow-auto">
                      {JSON.stringify(normalized.raw ?? holdingsData, null, 2)}
                    </pre>
                  </details>
                </div>
              );
            }

            return (
              <div className="mt-4 space-y-3">
                <div className="text-xs text-gray-700">
                  Showing <strong>{positions.length}</strong> position(s)
                </div>
                <div className="overflow-auto">
                  <table className="min-w-full bg-white border border-gray-300">
                    <thead>
                      <tr>
                        <th className="border px-3 py-2 text-left">Symbol</th>
                        <th className="border px-3 py-2 text-left">Name</th>
                        <th className="border px-3 py-2 text-right">Quantity</th>
                        <th className="border px-3 py-2 text-right">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {positions.map((p, idx) => {
                        const symbol = formatTicker(p);
                        const name = formatSecurityName(p);
                        const quantity =
                          p.quantity ?? p.units ?? p.shares ?? p?.position?.quantity;
                        const price =
                          p.price ?? p?.pricePerShare ?? p?.quote?.last ?? p?.lastPrice;

                        return (
                          <tr key={`${symbol}-${idx}`}>
                            <td className="border px-3 py-2 font-mono text-sm">
                              {String(symbol)}
                            </td>
                            <td className="border px-3 py-2 text-sm">{String(name)}</td>
                            <td className="border px-3 py-2 text-right text-sm">
                              {quantity ?? ""}
                            </td>
                            <td className="border px-3 py-2 text-right text-sm">
                              {price ?? ""}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <details>
                  <summary className="cursor-pointer text-sm text-purple-800">
                    Show raw response
                  </summary>
                  <pre className="mt-2 text-xs bg-white p-3 rounded border overflow-auto">
                    {JSON.stringify(normalized.raw ?? holdingsData, null, 2)}
                  </pre>
                </details>
              </div>
            );
          })()}
        </div>
      )}

      <div className="space-y-6">
        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-green-800">Connected Users</h2>
              <p className="text-sm text-gray-600">
                Users with at least one connected brokerage account returned by SnapTrade.
              </p>
            </div>
            <div className="rounded-full bg-green-100 px-3 py-1 text-sm font-semibold text-green-800">
              {connectedUsers.length}
            </div>
          </div>
          {connectedUsers.length ? (
            renderUserTable(connectedUsers)
          ) : (
            <div className="rounded border border-dashed border-gray-300 bg-white p-4 text-sm text-gray-600">
              No connected users found yet.
            </div>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-800">Disconnected Users</h2>
              <p className="text-sm text-gray-600">
                Users with no connected accounts yet or users missing a locally cached secret.
              </p>
            </div>
            <div className="rounded-full bg-slate-100 px-3 py-1 text-sm font-semibold text-slate-700">
              {disconnectedUsers.length}
            </div>
          </div>
          {disconnectedUsers.length ? (
            renderUserTable(disconnectedUsers)
          ) : (
            <div className="rounded border border-dashed border-gray-300 bg-white p-4 text-sm text-gray-600">
              No disconnected users.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
