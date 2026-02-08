import https from "https";

/** Current local version (synced with package.json) */
const LOCAL_VERSION = "1.1.0";

/** GitHub raw URL for the miner's package.json */
const VERSION_URL =
  "https://raw.githubusercontent.com/AIMineRes/PoAIW/main/miner/package.json";

/**
 * Check if a newer version is available on GitHub.
 * Non-blocking — silently returns if network fails.
 */
export async function checkForUpdates(): Promise<void> {
  try {
    const remoteVersion = await fetchRemoteVersion();
    if (!remoteVersion) return;

    if (isNewer(remoteVersion, LOCAL_VERSION)) {
      console.log("");
      console.log(
        `  \x1b[33m[UPDATE]\x1b[0m New version available: \x1b[1mv${remoteVersion}\x1b[0m (current: v${LOCAL_VERSION})`
      );
      console.log(
        `  \x1b[90mRun: \x1b[36mcd PoAIW && git pull && cd miner && npm install\x1b[0m`
      );
      console.log("");
    }
  } catch {
    // Silently ignore — update check is non-critical
  }
}

/**
 * Fetch the version string from the remote package.json
 */
function fetchRemoteVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 5000);

    https
      .get(VERSION_URL, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          clearTimeout(timeout);
          try {
            const pkg = JSON.parse(data);
            resolve(pkg.version || null);
          } catch {
            resolve(null);
          }
        });
      })
      .on("error", () => {
        clearTimeout(timeout);
        resolve(null);
      });
  });
}

/**
 * Compare semver strings: is remote newer than local?
 */
function isNewer(remote: string, local: string): boolean {
  const r = remote.split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

/** Get current local version */
export function getVersion(): string {
  return LOCAL_VERSION;
}
