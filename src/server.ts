import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { Indexer } from "./indexer";
import { createEmbedder } from "./embedder";
import { SearchEngine } from "./search";

const DATA_DIR = process.env.CODEBASE_RAG_DATA || "./data";

/**
 * Register all tools on the MCP server instance.
 */
function registerTools(server: McpServer, search: SearchEngine, embedderName: string) {
  server.tool(
    "search",
    "Fast keyword search across the indexed codebase. Uses FTS5 with BM25 ranking and Porter stemming. Best for finding specific function names, variables, or exact terms.",
    {
      query: z.string().describe("Search query (keywords, function names, etc.)"),
      limit: z.number().optional().default(10).describe("Max results to return"),
    },
    async ({ query, limit }) => ({
      content: [{
        type: "text" as const,
        text: formatResults("Keyword Search", query, await search.keyword(query, limit)),
      }],
    }),
  );

  server.tool(
    "semantic_search",
    "Semantic search that understands meaning, not just keywords. Finds conceptually related code even if different words are used. Uses local embeddings by default (no API key needed).",
    {
      query: z.string().describe("Natural language query about code concepts"),
      limit: z.number().optional().default(10).describe("Max results to return"),
    },
    async ({ query, limit }) => {
      try {
        const results = await search.semantic(query, limit);
        return {
          content: [{ type: "text" as const, text: formatResults("Semantic Search", query, results) }],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Semantic search error: ${e.message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "query",
    "Hybrid search combining keyword matching and semantic understanding for best results. Uses Reciprocal Rank Fusion to merge rankings. This is the recommended search tool.",
    {
      query: z.string().describe("Natural language question about the codebase"),
      limit: z.number().optional().default(10).describe("Max results to return"),
    },
    async ({ query, limit }) => ({
      content: [{
        type: "text" as const,
        text: formatResults("Hybrid Search", query, await search.hybrid(query, limit)),
      }],
    }),
  );

  server.tool(
    "stats",
    "Get statistics about the indexed codebase: number of files, chunks, vectors, and which repos are indexed.",
    {},
    async () => {
      const s = search.stats();
      return {
        content: [{
          type: "text" as const,
          text: [
            `Codebase Index Stats:`,
            `  Files indexed: ${s.totalFiles}`,
            `  Code chunks: ${s.totalChunks}`,
            `  Vectors stored: ${s.totalVectors}`,
            `  Repos: ${s.repos.join(", ") || "none"}`,
            `  Embedding model: ${embedderName}`,
          ].join("\n"),
        }],
      };
    },
  );
}

/**
 * Create a configured MCP server with all tools registered.
 */
async function createServer() {
  const indexer = new Indexer(DATA_DIR);
  const embedder = createEmbedder();
  await embedder.init();
  const search = new SearchEngine(indexer, embedder);

  const server = new McpServer({
    name: "codebase-rag",
    version: "1.0.0",
  });

  registerTools(server, search, embedder.modelName);

  return { server, indexer, embedder, search };
}

/**
 * Start MCP server in stdio mode (for local Claude Code / Cursor).
 */
export async function startStdioServer() {
  const { server } = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("codebase-rag MCP server running on stdio");
}

/**
 * Start MCP server in HTTP mode (for remote access).
 * Supports Streamable HTTP transport (SSE + JSON-RPC).
 */
export async function startHttpServer(port: number = 3100) {
  // Shared state
  const indexer = new Indexer(DATA_DIR);
  const embedder = createEmbedder();
  await embedder.init();
  const search = new SearchEngine(indexer, embedder);

  // Track sessions for stateful connections
  const sessions = new Map<string, { server: McpServer; transport: WebStandardStreamableHTTPServerTransport }>();

  const httpServer = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // Health check
      if (url.pathname === "/health") {
        const stats = search.stats();
        return Response.json({
          status: "ok",
          indexed: {
            files: stats.totalFiles,
            chunks: stats.totalChunks,
            vectors: stats.totalVectors,
            repos: stats.repos,
          },
        });
      }

      // MCP endpoint
      if (url.pathname === "/mcp") {
        const sessionId = req.headers.get("mcp-session-id");

        // Existing session
        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;

          if (req.method === "DELETE") {
            await session.transport.close();
            sessions.delete(sessionId);
            return new Response(null, { status: 204 });
          }

          return session.transport.handleRequest(req);
        }

        // New session — create fresh server + transport
        if (req.method === "POST" || req.method === "GET") {
          const server = new McpServer({
            name: "codebase-rag",
            version: "1.0.0",
          });
          registerTools(server, search, embedder.modelName);

          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, { server, transport });
              console.error(`Session created: ${id}`);
            },
            onsessionclosed: (id) => {
              sessions.delete(id);
              console.error(`Session closed: ${id}`);
            },
          });

          await server.connect(transport);
          return transport.handleRequest(req);
        }

        return new Response("Method not allowed", { status: 405 });
      }

      // Root — info page
      if (url.pathname === "/") {
        const stats = search.stats();
        return new Response(
          [
            "codebase-rag MCP Server",
            "",
            `Files indexed: ${stats.totalFiles}`,
            `Chunks: ${stats.totalChunks}`,
            `Vectors: ${stats.totalVectors}`,
            `Repos: ${stats.repos.join(", ") || "none"}`,
            "",
            "MCP endpoint: POST /mcp",
            "Health check: GET /health",
            "",
            "Connect from Claude Code:",
            JSON.stringify({
              mcpServers: {
                codebase: {
                  type: "streamable-http",
                  url: `http://localhost:${port}/mcp`,
                },
              },
            }, null, 2),
          ].join("\n"),
          { headers: { "Content-Type": "text/plain" } },
        );
      }

      return new Response("Not found", { status: 404 });
    },
  });

  console.error(`codebase-rag MCP server running on http://localhost:${port}`);
  console.error(`  MCP endpoint: http://localhost:${port}/mcp`);
  console.error(`  Health check: http://localhost:${port}/health`);

  return httpServer;
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
  const mode = process.argv[2];
  if (mode === "http") {
    const port = parseInt(process.argv[3] || process.env.PORT || "3100");
    startHttpServer(port).catch((e) => {
      console.error("Fatal:", e);
      process.exit(1);
    });
  } else {
    startStdioServer().catch((e) => {
      console.error("Fatal:", e);
      process.exit(1);
    });
  }
}
