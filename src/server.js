import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";

// Railway deployments sometimes inject PORT=3000 by default. We want the wrapper to
// reliably listen on 8080 unless explicitly overridden.
//
// Prefer OPENCLAW_PUBLIC_PORT (set in the Dockerfile / template) over PORT.
// Keep CLAWDBOT_PUBLIC_PORT as a backward-compat alias for older templates.
const PORT = Number.parseInt(
  process.env.OPENCLAW_PUBLIC_PORT ?? process.env.CLAWDBOT_PUBLIC_PORT ?? process.env.PORT ?? "8080",
  10,
);

// State/workspace
// OpenClaw defaults to ~/.openclaw. Keep CLAWDBOT_* as backward-compat aliases.
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  process.env.CLAWDBOT_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  process.env.CLAWDBOT_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// Gateway admin token (protects OpenClaw gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

// Persist auth credentials across container restarts.
// Saved to STATE_DIR/auth.json with restricted permissions.
function saveAuthCredentials(authChoice, envVar, secret) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(STATE_DIR, "auth.json"),
      JSON.stringify({ authChoice, envVar, secret }),
      { encoding: "utf8", mode: 0o600 }
    );
    console.log(`[convos] Persisted auth credentials to ${STATE_DIR}/auth.json`);
  } catch (err) {
    console.warn("[convos] Failed to persist auth credentials:", err.message);
  }
}

function restoreAuthCredentials() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "auth.json"), "utf8"));
    if (data.envVar && data.secret && !process.env[data.envVar]) {
      process.env[data.envVar] = data.secret;
      console.log(`[convos] Restored ${data.envVar} from saved auth credentials`);
    }
  } catch {
    // No saved credentials — nothing to restore.
  }
}

restoreAuthCredentials();

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;
const GATEWAY_PROXY_TIMEOUT_MS = Number.parseInt(process.env.GATEWAY_PROXY_TIMEOUT_MS ?? "60000", 10);
const GATEWAY_HTTP_TIMEOUT_MS = Number.parseInt(process.env.GATEWAY_HTTP_TIMEOUT_MS ?? "30000", 10);

// XMTP environment (production or dev) - controlled via Railway env var
const XMTP_ENV = process.env.XMTP_ENV || "production";

// Helper for calling Convos HTTP endpoints on the gateway.
// The Convos plugin exposes REST routes at /convos/setup, /convos/setup/status, /convos/setup/complete.
async function convosHttp(path, { method = "GET", body, timeoutMs = GATEWAY_HTTP_TIMEOUT_MS } = {}) {
  const url = `${GATEWAY_TARGET}${path}`;
  const headers = { Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}` };
  const opts = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    opts.signal = ctrl.signal;
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${method} ${path}: ${text}`);
    }
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

// Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    process.env.CLAWDBOT_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

// Check if Convos channel is actually configured (not just that a config file exists).
// A config file can exist from onboarding without Convos being set up.
function isConvosConfigured() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const cfg = JSON.parse(raw);
    return !!(cfg?.channels?.convos);
  } catch {
    return false;
  }
}

let gatewayProc = null;
let gatewayStarting = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const GATEWAY_READY_PROBE_TIMEOUT_MS = 5_000;

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!gatewayProc) {
      console.error("[gateway] Process exited before becoming ready");
      return false;
    }
    try {
      const paths = ["/openclaw", "/clawdbot", "/"];
      for (const p of paths) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), GATEWAY_READY_PROBE_TIMEOUT_MS);
          try {
            const res = await fetch(`${GATEWAY_TARGET}${p}`, { method: "GET", signal: ctrl.signal });
            if (res) return true;
          } finally {
            clearTimeout(t);
          }
        } catch {
          // try next path
        }
      }
    } catch {
      // not ready
    }
    await sleep(250);
  }
  return false;
}

function sanitizePluginPaths(cfg) {
  const dir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
  if (dir && fs.existsSync(dir)) return [dir];
  const paths = cfg?.plugins?.load?.paths;
  if (Array.isArray(paths)) {
    const valid = paths.filter((p) => typeof p === "string" && fs.existsSync(p));
    return valid.length ? valid : [];
  }
  return [];
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  const p = configPath();
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    const validPaths = sanitizePluginPaths(cfg);
    if (!cfg.plugins) cfg.plugins = {};
    if (!cfg.plugins.load) cfg.plugins.load = {};
    if (JSON.stringify(cfg.plugins.load.paths) !== JSON.stringify(validPaths)) {
      cfg.plugins.load.paths = validPaths;
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
      console.log("[gateway] Sanitized plugins.load.paths to existing dirs only");
    }
  } catch (e) {
    console.warn("[gateway] Could not sanitize config:", e.message);
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
  ];

  const proc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: ["inherit", "inherit", "pipe"],
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      // Backward-compat aliases
      CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR || STATE_DIR,
      CLAWDBOT_WORKSPACE_DIR: process.env.CLAWDBOT_WORKSPACE_DIR || WORKSPACE_DIR,
    },
  });
  gatewayProc = proc;

  let stderrBuf = "";
  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrBuf += text;
    process.stderr.write(`[gateway:err] ${text}`);
  });

  // Only clear gatewayProc if THIS process is still the current one.
  // Prevents a stale exit handler from wiping a newly spawned gateway reference.
  proc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    if (gatewayProc === proc) gatewayProc = null;
  });

  proc.on("exit", (code, signal) => {
    if (code !== 0 && stderrBuf) {
      console.error(`[gateway] stderr output:\n${stderrBuf}`);
    }
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    if (gatewayProc === proc) gatewayProc = null;
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    const MAX_GATEWAY_RETRIES = 3;
    gatewayStarting = (async () => {
      for (let attempt = 1; attempt <= MAX_GATEWAY_RETRIES; attempt++) {
        await startGateway();
        const ready = await waitForGatewayReady({ timeoutMs: 20_000 });
        if (ready) return;
        console.error(`[gateway] Attempt ${attempt}/${MAX_GATEWAY_RETRIES} failed`);
        if (gatewayProc) {
          try {
            gatewayProc.kill("SIGTERM");
          } catch {
            // ignore
          }
        }
        gatewayProc = null;
        if (attempt < MAX_GATEWAY_RETRIES) await sleep(1000);
      }
      throw new Error("Gateway did not become ready after retries");
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const pair of raw.split(";")) {
    const [k, v] = pair.trim().split("=");
    if (k && v) out[k] = decodeURIComponent(v);
  }
  return out;
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send("SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.");
  }

  // URL auth: ?password=test (sets cookie and redirects to avoid password in URL)
  const urlPassword = req.query?.password;
  if (urlPassword === SETUP_PASSWORD) {
    res.cookie("setup_auth", "1", { httpOnly: true, sameSite: "lax", path: "/setup", maxAge: 24 * 60 * 60 * 1000 });
    if (req.path === "/setup" && Object.keys(req.query || {}).length === 1) {
      return res.redirect("/setup");
    }
    return next();
  }

  // Cookie auth (set by ?password= above)
  const cookies = parseCookies(req);
  if (cookies.setup_auth === "1") return next();

  // Basic auth
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Minimal health endpoint for Railway.
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  // Serve JS for /setup (kept external to avoid inline encoding/template issues)
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "setup-app.js"), "utf8"));
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  const envBadgeClass = XMTP_ENV === "dev" ? "env-dev" : "env-production";
  const envLabel = XMTP_ENV === "dev" ? "dev" : "production";
  let html = fs.readFileSync(path.join(process.cwd(), "src", "setup.html"), "utf8");
  html = html.replace(/\{\{envBadgeClass\}\}/g, envBadgeClass).replace(/\{\{envLabel\}\}/g, envLabel);
  res.type("html").send(html);
});

// One short list: each entry is { model, envVar }; optional customProvider for gateway config.
// authChoice is only for CLI (buildOnboardArgs) compatibility.
const AUTH_PROVIDER_OPTIONS = [
  { model: "openai/gpt-5.1-codex-mini", envVar: "OPENAI_API_KEY",  },
  { model: "anthropic/claude-opus-4-5", envVar: "ANTHROPIC_API_KEY",  },
  { model: "openai/gpt-5.2", envVar: "OPENAI_API_KEY", },
  { model: "google/gemini-3-pro-preview", envVar: "GEMINI_API_KEY",  },
  { model: "openrouter/openai/gpt-4o", envVar: "OPENROUTER_API_KEY",  },
  { model: "ai-gateway/openai/gpt-4o", envVar: "AI_GATEWAY_API_KEY"},
  {
    model: "moonshot/kimi-k2.5",
    envVar: "MOONSHOT_API_KEY",
    customProvider: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [{ id: "kimi-k2.5", name: "Kimi K2.5" }],
      },
    },
  },
];

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));

  const authGroups = AUTH_PROVIDER_OPTIONS.map((opt, i) => ({
    value: String(i),
    label: opt.model,
    envVar: opt.envVar,
    envVarSet: !!(opt.envVar && process.env[opt.envVar]),
  }));

  res.json({
    configured: isConfigured(),
    gatewayToken: OPENCLAW_GATEWAY_TOKEN,
    convosConfigured: isConvosConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups,
  });
});

// Convos setup endpoint — writes config directly, starts gateway, calls POST /convos/setup
app.post("/setup/api/convos/setup", requireSetupAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const index = parseInt(payload.authGroup ?? payload.authChoice ?? "", 10);
    const option = !Number.isNaN(index) && AUTH_PROVIDER_OPTIONS[index] ? AUTH_PROVIDER_OPTIONS[index] : null;

    if (!option) {
      return res.status(400).json({ success: false, error: "No provider selected" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    // Stop any running gateway before rewriting config.
    if (gatewayProc) {
      console.log("[convos] Stopping existing gateway...");
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }
    gatewayStarting = null;

    console.log("[convos] Writing gateway config...");
    const secret = (payload.authSecret || "").trim();

    const config = {
      gateway: {
        mode: "local",
        port: INTERNAL_GATEWAY_PORT,
        bind: "loopback",
        auth: { mode: "token", token: OPENCLAW_GATEWAY_TOKEN },
        controlUi: { allowInsecureAuth: true },
      },
      plugins: {
        load: {
          paths: (() => {
            const dir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
            if (dir && fs.existsSync(dir)) return [dir];
            return [];
          })(),
        },
      },
    };

    config.agents = { defaults: { model: { primary: option.model } } };
    console.log(`[convos] Setting agent model: ${option.model}`);

    if (secret && option.envVar) {
      process.env[option.envVar] = secret;
      console.log(`[convos] Set ${option.envVar} from setup form`);
      saveAuthCredentials(option.model, option.envVar, secret);
    }

    if (option.customProvider) {
      config.models = { mode: "merge", providers: option.customProvider };
      console.log("[convos] Added custom provider config for", option.model);
    }

    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));

    // Start gateway (config is already written — single clean start)
    console.log("[convos] Starting gateway...");
    await ensureGatewayRunning();

    // Call POST /convos/setup on the running gateway
    console.log("[convos] Calling POST /convos/setup...");
    let result;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        result = await convosHttp("/convos/setup", {
          method: "POST",
          body: { env: XMTP_ENV, name: "OpenClaw" },
        });
        break;
      } catch (err) {
        if (attempt === 5) throw err;
        console.log(`[convos] Setup attempt ${attempt} failed, retrying...`);
        await sleep(2000);
      }
    }

    res.json({
      success: true,
      inviteUrl: result.inviteUrl,
      conversationId: result.conversationId,
    });
  } catch (err) {
    console.error("[convos] Setup failed:", err);
    res.status(500).json({
      success: false,
      error: err.message || String(err),
    });
  }
});

// Convos join status endpoint - passthrough to GET /convos/setup/status
app.get("/setup/api/convos/join-status", requireSetupAuth, async (req, res) => {
  try {
    const result = await convosHttp("/convos/setup/status");
    res.json({
      joined: result.joined,
      joinerInboxId: result.joinerInboxId || null,
      active: result.active,
    });
  } catch (err) {
    // If gateway is not running or endpoint fails, return not-joined state
    res.json({ joined: false, joinerInboxId: null, error: err.message });
  }
});

// Convos complete-setup endpoint - calls POST /convos/setup/complete
app.post("/setup/api/convos/complete-setup", requireSetupAuth, async (req, res) => {
  try {
    const result = await convosHttp("/convos/setup/complete", { method: "POST" });
    console.log("[convos] Setup complete:", result);

    res.json({
      ok: true,
      conversationId: result.conversationId,
    });
  } catch (err) {
    console.error("[/setup/api/convos/complete-setup] error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart"
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map secret to correct flag for common choices.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      "apiKey": "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key"
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token" && secret) {
      // This is the Anthropics setup-token flow.
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        // Backward-compat aliases
        CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR || STATE_DIR,
        CLAWDBOT_WORKSPACE_DIR: process.env.CLAWDBOT_WORKSPACE_DIR || WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({ ok: true, output: "Already configured.\nUse Reset setup if you want to rerun onboarding.\n" });
    }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const payload = req.body || {};
  const idx = parseInt(payload.authGroup, 10);
  if (!Number.isNaN(idx) && AUTH_PROVIDER_OPTIONS[idx]?.authChoice) {
    payload.authChoice = AUTH_PROVIDER_OPTIONS[idx].authChoice;
  }
  const onboardArgs = buildOnboardArgs(payload);
  const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

  let extra = "";

  const ok = onboard.code === 0 && isConfigured();

  // Optional channel setup (only after successful onboarding, and only if the installed CLI supports it).
  if (ok) {
    // Ensure gateway config is set so it can start properly.
    // (We enforce loopback bind since the wrapper proxies externally.)
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.mode", "local"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.mode", "token"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.bind", "loopback"]));
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));

    const channelsHelp = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
    const helpText = channelsHelp.output || "";

    const supports = (name) => helpText.includes(name);

    if (payload.telegramToken?.trim()) {
      if (!supports("telegram")) {
        extra += "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
      } else {
        // Avoid `channels add` here (it has proven flaky across builds); write config directly.
        const token = payload.telegramToken.trim();
        const cfgObj = {
          enabled: true,
          dmPolicy: "pairing",
          botToken: token,
          groupPolicy: "allowlist",
          streamMode: "partial",
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.telegram"]));
        extra += `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.discordToken?.trim()) {
      if (!supports("discord")) {
        extra += "\n[discord] skipped (this openclaw build does not list discord in `channels add --help`)\n";
      } else {
        const token = payload.discordToken.trim();
        const cfgObj = {
          enabled: true,
          token,
          groupPolicy: "allowlist",
          dm: {
            policy: "pairing",
          },
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.discord"]));
        extra += `\n[discord config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
      if (!supports("slack")) {
        extra += "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
      } else {
        const cfgObj = {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]),
        );
        const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "channels.slack"]));
        extra += `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
        extra += `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
      }
    }

    // Apply changes immediately.
    await restartGateway();
  }

  return res.status(ok ? 200 : 500).json({
    ok,
    output: `${onboard.output}${extra}`,
  });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res.status(500).json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(path.join(STATE_DIR, "gateway.token")),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

// --- Debug console (Option A: allowlisted commands + config editor) ---

function redactSecrets(text) {
  if (!text) return text;
  // Very small best-effort redaction. (Config paths/values may still contain secrets.)
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(gho_[A-Za-z0-9_]{10,})/g, "[REDACTED]")
    .replace(/(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]")
    .replace(/(AA[A-Za-z0-9_-]{10,}:\S{10,})/g, "[REDACTED]");
}

const ALLOWED_CONSOLE_COMMANDS = new Set([
  // Wrapper-managed lifecycle
  "gateway.restart",
  "gateway.stop",
  "gateway.start",

  // OpenClaw CLI helpers
  "openclaw.version",
  "openclaw.status",
  "openclaw.health",
  "openclaw.doctor",
  "openclaw.logs.tail",
  "openclaw.config.get",
]);

app.post("/setup/api/console/run", requireSetupAuth, async (req, res) => {
  const payload = req.body || {};
  const cmd = String(payload.cmd || "").trim();
  const arg = String(payload.arg || "").trim();

  if (!ALLOWED_CONSOLE_COMMANDS.has(cmd)) {
    return res.status(400).json({ ok: false, error: "Command not allowed" });
  }

  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return res.json({ ok: true, output: "Gateway restarted (wrapper-managed).\n" });
    }
    if (cmd === "gateway.stop") {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
      return res.json({ ok: true, output: "Gateway stopped (wrapper-managed).\n" });
    }
    if (cmd === "gateway.start") {
      const r = await ensureGatewayRunning();
      return res.json({ ok: Boolean(r.ok), output: r.ok ? "Gateway started.\n" : `Gateway not started: ${r.reason}\n` });
    }

    if (cmd === "openclaw.version") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.status") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["status"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.health") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["health"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.doctor") {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor"]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.logs.tail") {
      const lines = Math.max(50, Math.min(1000, Number.parseInt(arg || "200", 10) || 200));
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["logs", "--tail", String(lines)]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }
    if (cmd === "openclaw.config.get") {
      if (!arg) return res.status(400).json({ ok: false, error: "Missing config path" });
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", arg]));
      return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: redactSecrets(r.output) });
    }

    return res.status(400).json({ ok: false, error: "Unhandled command" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get("/setup/api/config/raw", requireSetupAuth, async (_req, res) => {
  try {
    const p = configPath();
    const exists = fs.existsSync(p);
    const content = exists ? fs.readFileSync(p, "utf8") : "";
    res.json({ ok: true, path: p, exists, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/config/raw", requireSetupAuth, async (req, res) => {
  try {
    const content = String((req.body && req.body.content) || "");
    if (content.length > 500_000) {
      return res.status(413).json({ ok: false, error: "Config too large" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });

    const p = configPath();
    // Backup
    if (fs.existsSync(p)) {
      const backupPath = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(p, backupPath);
    }

    fs.writeFileSync(p, content, { encoding: "utf8", mode: 0o600 });

    // Apply immediately.
    if (isConfigured()) {
      await restartGateway();
    }

    res.json({ ok: true, path: p });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res.status(400).json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  // Stop gateway so it doesn't hold stale config or recreate files.
  if (gatewayProc) {
    try { gatewayProc.kill("SIGTERM"); } catch {}
    await sleep(750);
    gatewayProc = null;
  }
  // Minimal reset: delete the config file so /setup can rerun.
  // Keep credentials/sessions/workspace by default.
  try {
    fs.rmSync(configPath(), { force: true });
    res.type("text/plain").send("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  // Prefer exporting from a common /data root so archives are easy to inspect and restore.
  // This preserves dotfiles like /data/.openclaw/openclaw.json.
  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    // We export relative to /data so the archive contains: .openclaw/... and workspace/...
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

function isUnderDir(p, root) {
  const abs = path.resolve(p);
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function looksSafeTarPath(p) {
  if (!p) return false;
  // tar paths always use / separators
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  // windows drive letters
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  // path traversal
  if (p.split("/").includes("..")) return false;
  return true;
}

async function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Import a backup created by /setup/export.
// This is intentionally limited to restoring into /data to avoid overwriting arbitrary host paths.
app.post("/setup/import", requireSetupAuth, async (req, res) => {
  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return res
        .status(400)
        .type("text/plain")
        .send("Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data (Railway volume).\n");
    }

    // Stop gateway before restore so we don't overwrite live files.
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }

    const buf = await readBodyBuffer(req, 250 * 1024 * 1024); // 250MB max
    if (!buf.length) return res.status(400).type("text/plain").send("Empty body\n");

    // Extract into /data.
    // We only allow safe relative paths, and we intentionally do NOT delete existing files.
    // (Users can reset/redeploy or manually clean the volume if desired.)
    const tmpPath = path.join(os.tmpdir(), `openclaw-import-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpPath, buf);

    await tar.x({
      file: tmpPath,
      cwd: dataRoot,
      gzip: true,
      strict: true,
      onwarn: () => {},
      filter: (p) => {
        // Allow only paths that look safe.
        return looksSafeTarPath(p);
      },
    });

    try { fs.rmSync(tmpPath, { force: true }); } catch {}

    // Restart gateway after restore.
    if (isConfigured()) {
      await restartGateway();
    }

    res.type("text/plain").send("OK - imported backup into /data and restarted gateway.\n");
  } catch (err) {
    console.error("[import]", err);
    res.status(500).type("text/plain").send(String(err));
  }
});

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
  proxyTimeout: GATEWAY_PROXY_TIMEOUT_MS,
});

proxy.on("error", (err, _req, _res) => {
  console.error("[proxy]", err);
});

app.use(async (req, res) => {
  // If not configured, force users to /setup for any non-setup routes.
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      return res.status(503).type("text/plain").send(`Gateway not ready: ${String(err)}`);
    }
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[wrapper] listening on :${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);
  console.log(`[wrapper] gateway token: ${OPENCLAW_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  if (!SETUP_PASSWORD) {
    console.warn("[wrapper] WARNING: SETUP_PASSWORD is not set; /setup will error.");
  }
  // Don't start gateway unless configured; proxy will ensure it starts.
});

server.on("upgrade", async (req, socket, head) => {
  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

process.on("SIGTERM", () => {
  // Best-effort shutdown
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(0);
});
