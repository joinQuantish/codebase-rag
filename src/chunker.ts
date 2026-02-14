import { readFileSync } from "fs";
import { basename, extname } from "path";

export interface Chunk {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  type: "code" | "doc";
  language: string;
}

const MAX_CHUNK_LINES = 60;
const OVERLAP_LINES = 8;

// Language detection from extension
const LANG_MAP: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java", ".kt": "kotlin", ".scala": "scala",
  ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".cs": "csharp",
  ".sol": "solidity",
  ".md": "markdown", ".mdx": "markdown",
  ".json": "json",
  ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml",
  ".sh": "bash", ".bash": "bash",
  ".sql": "sql",
  ".graphql": "graphql", ".gql": "graphql",
  ".proto": "protobuf",
  ".tf": "terraform",
};

// Patterns that indicate a logical boundary in code
const BOUNDARY_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^export\s+(default\s+)?(function|class|interface|type|enum|const|let|abstract)/,
    /^(function|class|interface|type|enum)\s/,
    /^(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/,  // arrow functions
    /^(describe|it|test|beforeAll|afterAll)\(/,       // tests
    /^\/\*\*/,                                        // JSDoc
  ],
  javascript: [
    /^export\s+(default\s+)?(function|class|const|let)/,
    /^(function|class)\s/,
    /^(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/,
    /^(describe|it|test)\(/,
    /^\/\*\*/,
  ],
  python: [
    /^(def|class|async\s+def)\s/,
    /^@\w/,                    // decorators
    /^(if\s+__name__|import|from)\s/,
  ],
  rust: [
    /^(pub\s+)?(fn|struct|enum|impl|trait|mod|use)\s/,
    /^#\[/,                    // attributes
  ],
  go: [
    /^func\s/,
    /^type\s+\w+\s+(struct|interface)/,
    /^(package|import)\s/,
  ],
  markdown: [
    /^#{1,3}\s/,               // headings
    /^---\s*$/,                // horizontal rule
  ],
};

/**
 * Chunk a file into logical segments for embedding.
 * Tries to split on function/class boundaries, falls back to line windows.
 */
export function chunkFile(filePath: string): Chunk[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  if (!content.trim()) return [];

  const ext = extname(filePath).toLowerCase();
  const language = LANG_MAP[ext] || basename(filePath).toLowerCase();
  const type = language === "markdown" ? "doc" : "code";
  const lines = content.split("\n");

  // For small files, single chunk
  if (lines.length <= MAX_CHUNK_LINES) {
    return [{
      filePath,
      startLine: 1,
      endLine: lines.length,
      content: formatChunk(filePath, lines, 1, language),
      type,
      language,
    }];
  }

  // Find logical boundaries
  const boundaries = findBoundaries(lines, language);

  if (boundaries.length > 1) {
    return chunkByBoundaries(filePath, lines, boundaries, type, language);
  }

  // Fallback: sliding window
  return chunkByWindow(filePath, lines, type, language);
}

function findBoundaries(lines: string[], language: string): number[] {
  const patterns = BOUNDARY_PATTERNS[language] || [];
  if (patterns.length === 0) return [];

  const boundaries: number[] = [0]; // always start at line 0

  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    // Only match top-level declarations (no indentation or minimal)
    const indent = lines[i].length - lines[i].trimStart().length;
    if (indent > 2) continue; // skip deeply indented lines

    for (const pattern of patterns) {
      if (pattern.test(trimmed)) {
        // Don't create tiny chunks
        const lastBoundary = boundaries[boundaries.length - 1];
        if (i - lastBoundary >= 5) {
          boundaries.push(i);
        }
        break;
      }
    }
  }

  return boundaries;
}

function chunkByBoundaries(
  filePath: string,
  lines: string[],
  boundaries: number[],
  type: "code" | "doc",
  language: string,
): Chunk[] {
  const chunks: Chunk[] = [];

  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : lines.length;
    const chunkLines = lines.slice(start, end);

    // If this chunk is too big, sub-chunk it with windows
    if (chunkLines.length > MAX_CHUNK_LINES * 1.5) {
      const subChunks = chunkByWindow(
        filePath,
        chunkLines,
        type,
        language,
        start + 1,
      );
      chunks.push(...subChunks);
    } else {
      chunks.push({
        filePath,
        startLine: start + 1,
        endLine: end,
        content: formatChunk(filePath, chunkLines, start + 1, language),
        type,
        language,
      });
    }
  }

  return chunks;
}

function chunkByWindow(
  filePath: string,
  lines: string[],
  type: "code" | "doc",
  language: string,
  lineOffset: number = 1,
): Chunk[] {
  const chunks: Chunk[] = [];
  let pos = 0;

  while (pos < lines.length) {
    const end = Math.min(pos + MAX_CHUNK_LINES, lines.length);
    const chunkLines = lines.slice(pos, end);

    chunks.push({
      filePath,
      startLine: pos + lineOffset,
      endLine: end + lineOffset - 1,
      content: formatChunk(filePath, chunkLines, pos + lineOffset, language),
      type,
      language,
    });

    pos += MAX_CHUNK_LINES - OVERLAP_LINES;
    if (end >= lines.length) break;
  }

  return chunks;
}

/**
 * Format a chunk with file path header for context.
 */
function formatChunk(
  filePath: string,
  lines: string[],
  startLine: number,
  language: string,
): string {
  // Strip the repo root to get relative path
  const relPath = filePath.replace(/^.*\/repos\/[^/]+\//, "");
  const header = `// File: ${relPath} (lines ${startLine}-${startLine + lines.length - 1})`;
  return `${header}\n${lines.join("\n")}`;
}
