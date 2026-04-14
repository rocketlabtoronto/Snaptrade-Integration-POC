const { spawn } = require("child_process");
const axios = require("axios");
const os = require("os");
const { findFreePorts } = require("./findFreePorts");

// Get network interfaces to show available IPs
function getNetworkIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal and non-IPv4 addresses
      if (!iface.internal && iface.family === "IPv4") {
        ips.push(iface.address);
      }
    }
  }

  return ips;
}

// Ports are selected dynamically at runtime (do NOT read from .env)
let BACKEND_PORT;
let FRONTEND_PORT;
let BACKEND_URL;

// Colors for console output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
};

function log(prefix, message, color = colors.reset) {
  console.log(`${color}[${prefix}]${colors.reset} ${message}`);
}

function killChildTree(child) {
  if (!child || child.killed) return;
  const isWindows = process.platform === "win32";
  if (isWindows) {
    // Kill the whole process tree on Windows.
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      shell: true,
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
}

// Function to kill process on a specific port
async function killProcessOnPort(port) {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";

    if (isWindows) {
      // Windows: Use netstat and taskkill
      const findProcess = spawn("netstat", ["-ano"], { shell: true });
      let output = "";

      findProcess.stdout.on("data", (data) => {
        output += data.toString();
      });

      findProcess.on("close", () => {
        const lines = output.split("\n");
        const portPattern = new RegExp(`:${port}\\s`, "i");

        for (const line of lines) {
          if (portPattern.test(line) && line.includes("LISTENING")) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];

            if (pid && !isNaN(pid)) {
              log(
                "CLEANUP",
                `Killing process ${pid} on port ${port}`,
                colors.yellow
              );
              spawn("taskkill", ["/F", "/PID", pid], { shell: true });
              setTimeout(resolve, 1000); // Give it time to kill
              return;
            }
          }
        }
        resolve(); // No process found
      });

      findProcess.on("error", () => resolve());
    } else {
      // Unix/Linux/Mac: Use lsof and kill
      const findProcess = spawn("lsof", ["-ti", `tcp:${port}`]);
      let pid = "";

      findProcess.stdout.on("data", (data) => {
        pid += data.toString().trim();
      });

      findProcess.on("close", (code) => {
        if (code === 0 && pid) {
          log(
            "CLEANUP",
            `Killing process ${pid} on port ${port}`,
            colors.yellow
          );
          spawn("kill", ["-9", pid]);
          setTimeout(resolve, 1000); // Give it time to kill
        } else {
          resolve(); // No process found
        }
      });

      findProcess.on("error", () => resolve());
    }
  });
}

async function waitForBackend(maxRetries = 30) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await axios.get(`${BACKEND_URL}/api/health`);
      log("STARTUP", "Backend is ready!", colors.green);
      return true;
    } catch (error) {
      if (i === 0) {
        log("STARTUP", "Waiting for backend to start...", colors.cyan);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  log("STARTUP", "Backend failed to start within 30 seconds", colors.red);
  return false;
}

async function startServices() {
  log("STARTUP", "Starting SnapTrade Admin Panel...", colors.bright);

  const { backendPort, frontendPort } = await findFreePorts({
    preferredBackendPort: 3005,
    preferredFrontendPort: 3000,
  });

  BACKEND_PORT = backendPort;
  FRONTEND_PORT = frontendPort;
  BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

  // Clean up any existing processes on the ports
  log("CLEANUP", "Checking for existing processes on ports...", colors.cyan);
  await killProcessOnPort(BACKEND_PORT);
  await killProcessOnPort(FRONTEND_PORT);
  log("CLEANUP", "Port cleanup complete", colors.cyan);

  // Start backend
  log("BACKEND", "Starting backend server...", colors.blue);
  const backend = spawn("npm", ["run", "dev"], {
    cwd: "./backend",
    env: {
      ...process.env,
      BACKEND_PORT: String(BACKEND_PORT),
      // Helpful for backend-side redirects (if used)
      FRONT_END_URL: `http://localhost:${FRONTEND_PORT}`,
    },
    stdio: "pipe",
    shell: true,
  });

  backend.stdout.on("data", (data) => {
    const message = data.toString().trim();
    if (message) {
      log("BACKEND", message, colors.blue);
    }
  });

  backend.stderr.on("data", (data) => {
    const message = data.toString().trim();
    if (message) {
      log("BACKEND", message, colors.red);
    }
  });

  // Wait for backend to be ready
  const backendReady = await waitForBackend();

  if (!backendReady) {
    log("STARTUP", "Failed to start backend, aborting...", colors.red);
    backend.kill();
    process.exit(1);
  }

  // Start frontend
  log("FRONTEND", "Starting frontend...", colors.green);
  const frontend = spawn("npm", ["start"], {
    env: {
      ...process.env,
      PORT: String(FRONTEND_PORT),
      BACKEND_PORT: String(BACKEND_PORT),
      REACT_APP_BACKEND_URL: BACKEND_URL,
      // some codebases use this name
      REACT_APP_API_BASE_URL: `${BACKEND_URL}/api`,
    },
    stdio: "pipe",
    shell: true,
  });

  frontend.stdout.on("data", (data) => {
    const message = data.toString().trim();
    if (message) {
      log("FRONTEND", message, colors.green);
    }
  });

  frontend.stderr.on("data", (data) => {
    const message = data.toString().trim();
    if (message) {
      log("FRONTEND", message, colors.red);
    }
  });

  // Handle shutdown
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    log("STARTUP", `Shutting down services (${signal})...`, colors.cyan);
    killChildTree(frontend);
    killChildTree(backend);

    // Give processes a moment to exit before forcing port cleanup.
    await new Promise((r) => setTimeout(r, 1500));
    await killProcessOnPort(BACKEND_PORT);
    await killProcessOnPort(FRONTEND_PORT);
    log("STARTUP", "Shutdown complete. Ports released.", colors.cyan);
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Show network information
  const networkIPs = getNetworkIPs();

  log("STARTUP", "Both services are running!", colors.bright);
  log("STARTUP", "Frontend URLs:", colors.green);
  log("STARTUP", `  Local:    http://localhost:${FRONTEND_PORT}`, colors.green);

  if (networkIPs.length > 0) {
    networkIPs.forEach((ip) => {
      log("STARTUP", `  Network:  http://${ip}:${FRONTEND_PORT}`, colors.green);
    });
  }

  log("STARTUP", "Backend URLs:", colors.blue);
  log("STARTUP", `  Local:    http://localhost:${BACKEND_PORT}`, colors.blue);

  if (networkIPs.length > 0) {
    networkIPs.forEach((ip) => {
      log("STARTUP", `  Network:  http://${ip}:${BACKEND_PORT}`, colors.blue);
    });
  }

  log("STARTUP", "", colors.reset);
  log(
    "STARTUP",
    "Ports are chosen automatically each run (no .env ports).",
    colors.yellow
  );
  log(
    "STARTUP",
    `Frontend will call backend at: ${BACKEND_URL}`,
    colors.yellow
  );
  log("STARTUP", "", colors.reset);
  log("STARTUP", "Press Ctrl+C to stop both services", colors.cyan);
}

startServices().catch((error) => {
  log("STARTUP", `Error: ${error.message}`, colors.red);
  process.exit(1);
});
