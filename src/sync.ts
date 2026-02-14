import { execSync } from "child_process";
import { existsSync, statSync } from "fs";
import { join, basename } from "path";
import { createHash } from "crypto";

export interface SyncResult {
  repoDir: string;
  isNew: boolean;
  changedFiles: string[];
  allFiles: string[];
}

/**
 * Clone or pull a git repository and detect changed files.
 */
export function syncRepo(repoUrl: string, dataDir: string): SyncResult {
  const repoName = basename(repoUrl, ".git").replace(/\.git$/, "");
  const repoDir = join(dataDir, "repos", repoName);
  let isNew = false;

  if (!existsSync(repoDir)) {
    console.log(`Cloning ${repoUrl} → ${repoDir}`);
    execSync(`git clone --depth=1 ${repoUrl} ${repoDir}`, {
      stdio: "pipe",
    });
    isNew = true;
  } else {
    console.log(`Pulling latest for ${repoDir}`);
    execSync(`git -C ${repoDir} pull --ff-only 2>/dev/null || git -C ${repoDir} fetch --all && git -C ${repoDir} reset --hard origin/HEAD`, {
      stdio: "pipe",
    });
  }

  const allFiles = getTrackedFiles(repoDir);

  return {
    repoDir,
    isNew,
    changedFiles: allFiles, // on first pass, index everything
    allFiles,
  };
}

/**
 * Get all git-tracked files (respects .gitignore).
 */
function getTrackedFiles(repoDir: string): string[] {
  const output = execSync(`git -C ${repoDir} ls-files`, {
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
  const content = Bun.file(filePath);
  // Use sync read
  const buf = execSync(`cat "${filePath}"`, { encoding: "buffer" });
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
    // Skip binary/large/generated
    const parts = f.split("/");
    if (parts.some((p) => SKIP_DIRS.has(p))) return false;

    const ext = "." + f.split(".").pop()?.toLowerCase();
    if (!ext || !CODE_EXTENSIONS.has(ext)) {
      // Also include Dockerfile, Makefile, etc.
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
