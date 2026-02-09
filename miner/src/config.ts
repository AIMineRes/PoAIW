import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import inquirer from "inquirer";

// ======================== Built-in Constants ========================

/**
 * Built-in BNB Chain RPC endpoints (multiple for failover).
 * The actual URLs are not displayed to users.
 */
const DEFAULT_RPC_LIST = [
  "https://lb.drpc.live/bsc/AsVs23QoLEOwisC7Py3FTOoL9ez-0OkR8K7sOmy9-kY5",
];

/** AIMineCore contract address (BNB Chain mainnet) */
export const CORE_CONTRACT = "0xA21eed5825Cce36457bc28dAf8F9bB5C993b9F36";

/** AIMineToken contract address (BNB Chain mainnet) */
export const TOKEN_CONTRACT = "0xb7C143c71755E9b8733ED671ac282b4F7F5F4516";

// ======================== Types ========================

/**
 * Miner configuration interface
 */
export interface MinerConfig {
  // Blockchain connection
  rpcUrl: string;
  privateKey: string;
  coreContract: string;
  tokenContract: string;

  // AI settings
  openaiKey: string;
  aiModel: string;
  aiBatchSize: number;

  // Mining settings
  workers: number;
  gasLimit: number;
  maxNoncePerText: number;
}

// ======================== RPC Selection ========================

/**
 * Select an RPC endpoint.
 * If user provided a custom RPC, use that. Otherwise use the primary built-in RPC.
 * Fallback RPCs are available if needed.
 */
export function selectRpc(customRpc?: string): string {
  if (customRpc) return customRpc;
  return DEFAULT_RPC_LIST[0];
}

/**
 * Get all available RPC endpoints for failover.
 */
export function getAllRpcs(): string[] {
  return [...DEFAULT_RPC_LIST];
}

// ======================== .env Management ========================

/** Path to the .env configuration file */
const ENV_FILE = path.join(process.cwd(), ".env");

/**
 * Load configuration from .env file.
 * Returns null if .env is missing required fields.
 */
export function loadConfig(): MinerConfig | null {
  if (!fs.existsSync(ENV_FILE)) return null;

  const envContent = fs.readFileSync(ENV_FILE, "utf-8");
  const env: Record<string, string> = {};

  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  // Accept OPENAI_KEY or OPENAI_API_KEY (many systems use OPENAI_API_KEY)
  const openaiKey = env["OPENAI_KEY"] || env["OPENAI_API_KEY"];
  if (!env["PRIVATE_KEY"] || !openaiKey) return null;

  // Use custom RPC if provided, otherwise pick from built-in list
  const rpcUrl = selectRpc(env["CUSTOM_RPC"] || undefined);

  return {
    rpcUrl,
    privateKey: env["PRIVATE_KEY"],
    coreContract: CORE_CONTRACT,
    tokenContract: TOKEN_CONTRACT,
    openaiKey,
    aiModel: env["AI_MODEL"] || "gpt-4o-mini",
    aiBatchSize: parseInt(env["AI_BATCH_SIZE"] || "8"),
    workers: parseInt(
      env["WORKERS"] || String(Math.max(1, os.cpus().length - 1))
    ),
    gasLimit: parseInt(env["GAS_LIMIT"] || "500000"),
    maxNoncePerText: parseInt(env["MAX_NONCE"] || "5000000"),
  };
}

/**
 * Escape a value for .env: wrap in double quotes if it contains = or space so it parses correctly.
 */
function envValue(val: string): string {
  const trimmed = val.trim();
  if (trimmed.includes("=") || trimmed.includes(" ") || trimmed.includes('"')) {
    return `"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return trimmed;
}

/**
 * Build .env lines from a key-value set (used by writeEnvFromProcessEnv and writeEnvFromArgs).
 */
function buildEnvLines(options: {
  privateKey: string;
  openaiKey: string;
  aiModel?: string;
  workers?: number;
  customRpc?: string;
}): string[] {
  const workers =
    options.workers ?? Math.max(1, os.cpus().length - 1);
  const lines = [
    "# AI Mine Configuration",
    `# Generated at ${new Date().toISOString()}`,
    "",
    "# === Your Keys (keep these secret!) ===",
    `PRIVATE_KEY=${envValue(options.privateKey)}`,
    `OPENAI_KEY=${envValue(options.openaiKey)}`,
    "",
    "# === Mining Settings ===",
    `AI_MODEL=${options.aiModel ?? "gpt-4o-mini"}`,
    `WORKERS=${workers}`,
    "AI_BATCH_SIZE=8",
    "GAS_LIMIT=500000",
    "MAX_NONCE=5000000",
    "",
  ];
  if (options.customRpc) {
    lines.splice(7, 0, "", "# === Custom RPC (optional) ===", `CUSTOM_RPC=${options.customRpc}`);
  }
  return lines;
}

/**
 * Write .env from process.env (PRIVATE_KEY, OPENAI_KEY, etc.).
 * Used by OpenClaw / non-interactive init (e.g. ai-mine init --from-env).
 * Returns true if .env was written, false if required env vars are missing.
 */
export function writeEnvFromProcessEnv(): boolean {
  const privateKey = process.env["PRIVATE_KEY"]?.trim();
  const openaiKey = (process.env["OPENAI_KEY"] || process.env["OPENAI_API_KEY"])?.trim();
  if (!privateKey || !openaiKey) return false;
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) return false;
  if (!openaiKey.startsWith("sk-")) return false;

  const lines = buildEnvLines({
    privateKey,
    openaiKey,
    aiModel: process.env["AI_MODEL"] || undefined,
    workers: process.env["WORKERS"] ? parseInt(process.env["WORKERS"], 10) : undefined,
    customRpc: process.env["CUSTOM_RPC"] || undefined,
  });
  fs.writeFileSync(ENV_FILE, lines.join("\n"), "utf-8");
  return true;
}

/**
 * Options for writing .env from explicit args (e.g. CLI --private-key / --openai-key).
 */
export interface WriteEnvArgsOptions {
  privateKey: string;
  openaiKey: string;
  aiModel?: string;
  workers?: number;
}

/**
 * Write .env from explicit arguments. Used when user provides keys in chat (OpenClaw).
 */
export function writeEnvFromArgs(options: WriteEnvArgsOptions): void {
  const { privateKey, openaiKey } = options;
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error("PRIVATE_KEY must be a 64-char hex string starting with 0x");
  }
  if (!openaiKey.startsWith("sk-")) {
    throw new Error("OPENAI_KEY must start with sk-");
  }
  const lines = buildEnvLines({
    ...options,
    privateKey: privateKey.trim(),
    openaiKey: openaiKey.trim(),
  });
  fs.writeFileSync(ENV_FILE, lines.join("\n"), "utf-8");
}

/**
 * Interactive configuration wizard.
 * Only asks for wallet private key, OpenAI key, and optional tuning parameters.
 */
export async function initConfig(): Promise<void> {
  console.log("");
  console.log("  \x1b[1;36mAI Mine - Configuration Wizard\x1b[0m");
  console.log("  \x1b[90m─────────────────────────────────────\x1b[0m");
  console.log("");
  console.log("  \x1b[90mNetwork:  BNB Chain Mainnet\x1b[0m");
  console.log(
    "  \x1b[90mContract: " + CORE_CONTRACT.slice(0, 10) + "...\x1b[0m"
  );
  console.log("");

  const answers = await inquirer.prompt([
    {
      type: "password",
      name: "privateKey",
      message: "Your wallet private key (0x...):",
      mask: "*",
      validate: (v: string) =>
        /^0x[a-fA-F0-9]{64}$/.test(v)
          ? true
          : "Must be a 64-char hex string starting with 0x",
    },
    {
      type: "password",
      name: "openaiKey",
      message: "Your OpenAI API key (sk-...):",
      mask: "*",
      validate: (v: string) =>
        v.startsWith("sk-") ? true : "Must start with sk-",
    },
    {
      type: "list",
      name: "aiModel",
      message: "AI model:",
      choices: ["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo"],
      default: "gpt-4o-mini",
    },
    {
      type: "number",
      name: "workers",
      message: `CPU worker threads (your CPU has ${os.cpus().length} cores):`,
      default: Math.max(1, os.cpus().length - 1),
      validate: (v: number) =>
        v >= 1 && v <= os.cpus().length
          ? true
          : `Must be between 1 and ${os.cpus().length}`,
    },
    {
      type: "confirm",
      name: "useCustomRpc",
      message: "Use a custom RPC endpoint? (default: built-in)",
      default: false,
    },
    {
      type: "input",
      name: "customRpc",
      message: "Custom RPC URL:",
      when: (a: any) => a.useCustomRpc,
      validate: (v: string) =>
        v.startsWith("http") ? true : "Must be a valid HTTP(S) URL",
    },
  ]);

  // Build .env content
  const lines = [
    "# AI Mine Configuration",
    `# Generated at ${new Date().toISOString()}`,
    "",
    "# === Your Keys (keep these secret!) ===",
    `PRIVATE_KEY=${answers.privateKey}`,
    `OPENAI_KEY=${answers.openaiKey}`,
    "",
    "# === Mining Settings ===",
    `AI_MODEL=${answers.aiModel}`,
    `WORKERS=${answers.workers}`,
    "AI_BATCH_SIZE=8",
    "GAS_LIMIT=500000",
    "MAX_NONCE=5000000",
    "",
  ];

  // Only add custom RPC if user chose to
  if (answers.customRpc) {
    lines.splice(7, 0, "", "# === Custom RPC (optional) ===", `CUSTOM_RPC=${answers.customRpc}`);
  }

  fs.writeFileSync(ENV_FILE, lines.join("\n"), "utf-8");

  console.log("");
  console.log("  \x1b[32m\u2713 Configuration saved to .env\x1b[0m");
  console.log("  \x1b[90mYou can edit this file manually at any time.\x1b[0m");
  console.log("");
  console.log(
    "  \x1b[1mNext step:\x1b[0m Run \x1b[36mnpm start\x1b[0m to begin mining!"
  );
  console.log("");
}
