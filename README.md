# codebase-rag

Index any GitHub repository and search it instantly. No API keys needed. Runs 100% locally on CPU.

Exposes an MCP server so Claude Code, Cursor, or any LLM client can semantically search your codebase.

```
GitHub Repo → Clone → Chunk → Embed (local) → SQLite Index → MCP Server → LLM
```

## Quick Start

```bash
# Install
git clone https://github.com/joinQuantish/codebase-rag
cd codebase-rag
bun install

# Index any repo (auto-embeds, no API key needed!)
bun run src/cli.ts index https://github.com/your-org/your-repo

# Search
bun run src/cli.ts search "place order"                         # keyword (~2ms)
bun run src/cli.ts vsearch "how does authentication work"       # semantic (~28ms)
bun run src/cli.ts query "wallet encryption and key management" # hybrid (best)

# Start MCP server for Claude Code / Cursor
bun run src/cli.ts serve
```

**That's it.** No OpenAI key, no GPU, no external services.

## How It Works

### Indexing Pipeline
1. **Git sync** — Clones or pulls the repo, detects changed files via SHA256 hash
2. **File filter** — Selects code files (TS, Python, Rust, Go, etc.), skips node_modules/dist/binaries
3. **Code chunker** — Splits files on function/class boundaries, falls back to 60-line windows with overlap
4. **FTS5 index** — Every chunk goes into SQLite Full-Text Search with Porter stemming + BM25 ranking
5. **Vector embed** — Chunks embedded locally via all-MiniLM-L6-v2 (22MB ONNX model, runs on CPU)

### Search Modes

| Mode | Command | Speed | Best For |
|------|---------|-------|----------|
| Keyword | `search` | ~2ms | Function names, exact terms |
| Semantic | `vsearch` | ~28ms | Conceptual questions ("how does X work") |
| Hybrid | `query` | ~30ms | Best overall accuracy |

All three work out of the box, no API keys required.

### Embeddings

Default: **all-MiniLM-L6-v2** via `@huggingface/transformers` (ONNX Runtime on CPU)
- 384-dimensional vectors
- ~22MB quantized model (auto-downloaded on first run)
- ~4ms per chunk to embed
- Cached in `~/.cache/huggingface/`

Optionally swap to OpenAI for higher quality: set `OPENAI_API_KEY` env var.

## MCP Server

Two modes: **stdio** (local) and **HTTP** (remote/shared).

### Option A: Local (stdio)

For personal use with Claude Code or Cursor. Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "codebase": {
      "command": "bun",
      "args": ["run", "/path/to/codebase-rag/src/server.ts"],
      "env": {
        "CODEBASE_RAG_DATA": "/path/to/codebase-rag/data"
      }
    }
  }
}
```

### Option B: HTTP (remote)

For sharing with a team. Start the server, anyone can connect:

```bash
# Start HTTP server
bun run src/cli.ts serve --http --port=3100
```

Connect from Claude Code:

```json
{
  "mcpServers": {
    "codebase": {
      "type": "streamable-http",
      "url": "https://your-server.example.com/mcp"
    }
  }
}
```

**Endpoints:**
| Path | Method | Description |
|------|--------|-------------|
| `/mcp` | POST/GET/DELETE | MCP protocol (Streamable HTTP) |
| `/health` | GET | Health check + index stats (JSON) |
| `/` | GET | Server info + connection instructions |

### Tools Exposed

| Tool | Description |
|------|-------------|
| `search` | Fast keyword search (FTS5 + BM25) |
| `semantic_search` | Vector similarity search |
| `query` | Hybrid search (keyword + semantic, RRF fusion) — **recommended** |
| `stats` | Index statistics |

## Architecture

```
src/
  cli.ts       — CLI entry point
  sync.ts      — Git clone/pull + change detection
  chunker.ts   — Code-aware file splitting
  indexer.ts    — SQLite FTS5 + vector storage
  embedder.ts  — Local embeddings (HuggingFace) or OpenAI
  search.ts    — Search engine (keyword, semantic, hybrid)
  server.ts    — MCP server (stdio + HTTP transport)
```

## Supported Languages

TypeScript, JavaScript, Python, Rust, Go, Java, Kotlin, C/C++, Ruby, PHP, Swift, C#, Solidity, SQL, Markdown, YAML, TOML, Shell, GraphQL, Protobuf, Terraform

## Re-indexing

Run `index` again — it only re-indexes files whose content hash changed:

```bash
bun run src/cli.ts index https://github.com/your-org/your-repo
# ✅ Indexed 3 files, skipped 97 unchanged
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | No | Optional: use OpenAI embeddings instead of local |
| `EMBEDDING_MODEL` | No | Custom HuggingFace model (default: `Xenova/all-MiniLM-L6-v2`) |
| `EMBEDDING_BASE_URL` | No | Custom OpenAI-compatible endpoint (Ollama, vLLM) |
| `CODEBASE_RAG_DATA` | No | Data directory (default: `./data`) |

## Auto-sync (optional)

Set up a cron to re-index on a schedule:

```bash
# Re-index every 15 minutes
*/15 * * * * cd /path/to/codebase-rag && bun run src/cli.ts index https://github.com/your-org/your-repo
```

Or use a GitHub webhook to trigger on push.

## Stack

- **Runtime**: Bun
- **Database**: SQLite (bun:sqlite) with FTS5
- **Embeddings**: HuggingFace Transformers.js (ONNX, CPU, local)
- **MCP**: @modelcontextprotocol/sdk (stdio transport)
- **Zero external infrastructure** — single SQLite file, no API keys, no GPU, no Postgres/Pinecone
