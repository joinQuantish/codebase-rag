import { execSync } from "child_process";
import { existsSync, statSync, writeFileSync, chmodSync, unlinkSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { createHash } from "crypto";
import { readFileSync } from "fs";

export interface SyncResult {
  repoDir: string;
  isNew: boolean;
  changedFiles: string[];
  allFiles: string[];
}

export interface AuthConfig {
  /** GitHub Personal Access Token or App Install Token */
  token?: string;
  /** Path to SSH private key (deploy key) */
  sshKey?: string;
  /** Path to file containing the token (more secure than env var) */
  tokenFile?: string;
}

/**
 * Resolve auth token from multiple sources (in priority order):
 * 1. Explicit token param
 * 2. Token file path
 * 3. GITHUB_TOKEN env var
 * 4. GH_TOKEN env var (GitHub CLI convention)
 * 5. None (public repo)
 */
function resolveToken(auth?: AuthConfig): string | null {
  if (auth?.token) return auth.token;

  if (auth?.tokenFile) {
    try {
      return readFileSync(auth.tokenFile, "utf-8").trim();
    } catch (e: any) {
      throw new Error(`Cannot read token file ${auth.tokenFile}: ${e.message}`);
    }
  }

  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

/**
 * Build git environment variables for authenticated clone/pull.
 * Never puts credentials in the URL or command args.
 */
function buildGitEnv(auth?: AuthConfig, dataDir?: string): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  // Method 1: SSH deploy key
  if (auth?.sshKey) {
    if (!existsSync(auth.sshKey)) {
      throw new Error(`SSH key not found: ${auth.sshKey}`);
    }
    // Use GIT_SSH_COMMAND to specify the key without modifying ~/.ssh/config
    env.GIT_SSH_COMMAND = `ssh -i ${auth.sshKey} -o IdentitiesOnly=yes -o StrictHostKeyChecking=no`;
    return env;
  }

  // Method 2: Token via GIT_ASKPASS (never in URL or process args)
  const token = resolveToken(auth);
  if (token) {
    // Create a temporary askpass script that echoes the token.
    // This is the git-recommended way to provide credentials
    // without embedding them in URLs or command-line args.
    const askpassDir = join(dataDir || "/tmp", ".git-askpass");
    mkdirSync(askpassDir, { recursive: true });
    const askpassPath = join(askpassDir, `askpass-${process.pid}.sh`);

    writeFileSync(askpassPath, `#!/bin/sh\necho "${token}"\n`, { mode: 0o700 });
    chmodSync(askpassPath, 0o700);

    env.GIT_ASKPASS = askpassPath;
    // GIT_TERMINAL_PROMPT=0 prevents git from prompting interactively
    env.GIT_TERMINAL_PROMPT = "0";
    // Tell git to use "x-access-token" as the username (GitHub convention)
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "credential.username";
    env.GIT_CONFIG_VALUE_0 = "x-access-token";

    // Store path so we can clean up after
    env.__ASKPASS_CLEANUP = askpassPath;
    return env;
  }

  // No auth — public repo
  return env;
}

/**
 * Clean up temporary askpass script.
 */
function cleanupAskpass(env: Record<string, string>) {
  const path = env.__ASKPASS_CLEANUP;
  if (path && existsSync(path)) {
    try { unlinkSync(path); } catch {}
  }
}

/**
 * Clone or pull a git repository and detect changed files.
 * Supports private repos via token, SSH key, or token file.
 */
export function syncRepo(repoUrl: string, dataDir: string, auth?: AuthConfig): SyncResult {
  const repoName = basename(repoUrl, ".git").replace(/\.git$/, "");
  const repoDir = join(dataDir, "repos", repoName);
  const env = buildGitEnv(auth, dataDir);
  let isNew = false;

  try {
    if (!existsSync(repoDir)) {
      console.log(`Cloning ${repoUrl} → ${repoDir}`);
      execSync(`git clone --depth=1 "${repoUrl}" "${repoDir}"`, {
        stdio: "pipe",
        env,
      });
      isNew = true;
    } else {
      console.log(`Pulling latest for ${repoDir}`);
      execSync(
        `git -C "${repoDir}" pull --ff-only 2>/dev/null || git -C "${repoDir}" fetch --all && git -C "${repoDir}" reset --hard origin/HEAD`,
        { stdio: "pipe", env },
      );
    }
  } finally {
    // Always clean up temporary credentials
    cleanupAskpass(env);
  }

  const allFiles = getTrackedFiles(repoDir);

  return {
    repoDir,
    isNew,
    changedFiles: allFiles,
    allFiles,
  };
}

/**
 * Get all git-tracked files (respects .gitignore).
 */
function getTrackedFiles(repoDir: string): string[] {
  const output = execSync(`git -C "${repoDir}" ls-files`, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return output
    .trim()
    .split("\n")
    .filter((f) => f.length > 0)
    .map((f) => join(repoDir, f));
}

/**
 * Hash file content for change detection.
 */
export function hashFile(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

// File extensions we index
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi",
  ".rs",
  ".go",
  ".java", ".kt", ".scala",
  ".c", ".cpp", ".h", ".hpp",
  ".rb",
  ".php",
  ".swift",
  ".cs",
  ".sol",       // Solidity
  ".md", ".mdx",
  ".json",
  ".yaml", ".yml",
  ".toml",
  ".sh", ".bash",
  ".sql",
  ".graphql", ".gql",
  ".proto",
  ".tf",        // Terraform
  ".dockerfile",
  ".env.example",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next",
  "__pycache__", ".venv", "venv", "target",
  ".turbo", ".cache", "coverage", ".nyc_output",
  "vendor",
]);

/**
 * Filter files to only indexable code/docs.
 */
export function filterIndexableFiles(files: string[]): string[] {
  return files.filter((f) => {
    const parts = f.split("/");
    if (parts.some((p) => SKIP_DIRS.has(p))) return false;

    const ext = "." + f.split(".").pop()?.toLowerCase();
    if (!ext || !CODE_EXTENSIONS.has(ext)) {
      const name = basename(f).toLowerCase();
      if (["dockerfile", "makefile", "rakefile", "gemfile", "procfile"].includes(name)) {
        return true;
      }
      return false;
    }

    // Skip very large files (>500KB)
    try {
      const stat = statSync(f);
      if (stat.size > 500 * 1024) return false;
    } catch {
      return false;
    }

    return true;
  });
}
