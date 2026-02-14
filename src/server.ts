import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Indexer } from "./indexer";
import { createEmbedder } from "./embedder";
import { SearchEngine } from "./search";

const DATA_DIR = process.env.CODEBASE_RAG_DATA || "./data";

export async function startServer() {
  const indexer = new Indexer(DATA_DIR);
  const embedder = createEmbedder();
  const hasEmbedder = embedder.modelName !== "embeddinggemma-300m"; // local = not available
  const search = new SearchEngine(indexer, hasEmbedder ? embedder : null);

  const server = new McpServer({
    name: "codebase-rag",
    version: "1.0.0",
  });

  // Tool: keyword search (always available)
  server.tool(
    "search",
    "Fast keyword search across the indexed codebase. Uses FTS5 with BM25 ranking and Porter stemming. Best for finding specific function names, variables, or exact terms.",
    {
      query: z.string().describe("Search query (keywords, function names, etc.)"),
      limit: z.number().optional().default(10).describe("Max results to return"),
    },
    async ({ query, limit }) => {
      const results = await search.keyword(query, limit);
      return {
        content: [
          {
            type: "text" as const,
            text: formatResults("Keyword Search", query, results),
          },
        ],
      };
    },
  );

  // Tool: semantic search (if embedder available)
  server.tool(
    "semantic_search",
    "Semantic search that understands meaning, not just keywords. Finds conceptually related code even if different words are used. Requires embedding provider (set OPENAI_API_KEY).",
    {
      query: z.string().describe("Natural language query about code concepts"),
      limit: z.number().optional().default(10).describe("Max results to return"),
    },
    async ({ query, limit }) => {
      try {
        const results = await search.semantic(query, limit);
        return {
          content: [
            {
              type: "text" as const,
              text: formatResults("Semantic Search", query, results),
            },
          ],
        };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Semantic search unavailable: ${e.message}. Use 'search' for keyword search.`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Tool: hybrid search (best quality)
  server.tool(
    "query",
    "Hybrid search combining keyword matching and semantic understanding for best results. Uses Reciprocal Rank Fusion to merge rankings. This is the recommended search tool.",
    {
      query: z.string().describe("Natural language question about the codebase"),
      limit: z.number().optional().default(10).describe("Max results to return"),
    },
    async ({ query, limit }) => {
      const results = await search.hybrid(query, limit);
      return {
        content: [
          {
            type: "text" as const,
            text: formatResults("Hybrid Search", query, results),
          },
        ],
      };
    },
  );

  // Tool: index stats
  server.tool(
    "stats",
    "Get statistics about the indexed codebase: number of files, chunks, vectors, and which repos are indexed.",
    {},
    async () => {
      const s = search.stats();
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Codebase Index Stats:`,
              `  Files indexed: ${s.totalFiles}`,
              `  Code chunks: ${s.totalChunks}`,
              `  Vectors stored: ${s.totalVectors}`,
              `  Repos: ${s.repos.join(", ") || "none"}`,
              `  Semantic search: ${hasEmbedder ? "available" : "unavailable (set OPENAI_API_KEY)"}`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // Start
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("codebase-rag MCP server running on stdio");
}

function formatResults(
  method: string,
  query: string,
  results: { filePath: string; content: string; startLine: number; endLine: number; score: number; method: string }[],
): string {
  if (results.length === 0) {
    return `${method} for "${query}": No results found.`;
  }

  const lines = [`${method} for "${query}" — ${results.length} results:\n`];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(
      `--- Result ${i + 1} [${r.filePath}:${r.startLine}-${r.endLine}] (score: ${r.score.toFixed(3)}) ---`,
    );
    // Truncate very long chunks for display
    const content = r.content.length > 2000
      ? r.content.slice(0, 2000) + "\n... (truncated)"
      : r.content;
    lines.push(content);
    lines.push("");
  }

  return lines.join("\n");
}

// Run if called directly
if (import.meta.main) {
  startServer().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
