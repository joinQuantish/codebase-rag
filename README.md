# codebase-rag

Index any GitHub repository and search it instantly. Exposes an MCP server so Claude Code, Cursor, or any LLM client can semantically search your codebase.

```
GitHub Repo → Clone → Chunk → Embed → SQLite Index → MCP Server → LLM
```

## Quick Start

```bash
# Install
bun install

# Index a repo (keyword search — no API key needed)
bun run src/cli.ts index https://github.com/your-org/your-repo

# Index with embeddings (needs OPENAI_API_KEY)
OPENAI_API_KEY=sk-... bun run src/cli.ts index https://github.com/your-org/your-repo --embed

# Search
bun run src/cli.ts search "place order"        # keyword (FTS5, ~2ms)
bun run src/cli.ts vsearch "how does auth work" # semantic (vector similarity)
bun run src/cli.ts query "error handling flow"  # hybrid (best quality)

# Start MCP server
bun run src/cli.ts serve
```

## How It Works

### Indexing Pipeline
1. **Git sync** — Clones or pulls the repo, detects changed files via SHA256 hash
2. **File filter** — Selects code files (TS, Python, Rust, Go, etc.), skips node_modules/dist/binaries
3. **Code chunker** — Splits files on function/class boundaries (AST-aware patterns), falls back to 60-line windows with overlap
4. **FTS5 index** — Every chunk goes into SQLite Full-Text Search with Porter stemming + BM25 ranking
5. **Vector embed** (optional) — Chunks are embedded via OpenAI API and stored as float32 blobs

### Search Modes

| Mode | Command | Speed | Needs API Key | Best For |
|------|---------|-------|---------------|----------|
| Keyword | `search` | ~2ms | No | Function names, exact terms |
| Semantic | `vsearch` | ~200ms | Yes | Conceptual questions |
| Hybrid | `query` | ~200ms | Yes* | Best overall accuracy |

*Falls back to keyword-only if no API key is set.

### Why FTS5 is fast
Instead of scanning every line of every file (like grep), the index pre-computes an inverted index: `term → [chunk1, chunk5, chunk12]`. Searching is a dictionary lookup, not a full scan. Porter stemming means "searching" matches "search".

## MCP Server

Add to your Claude Code or Cursor config:

```json
{
  "mcpServers": {
    "codebase": {
      "command": "bun",
      "args": ["run", "/path/to/codebase-rag/src/server.ts"],
      "env": {
        "CODEBASE_RAG_DATA": "/path/to/codebase-rag/data",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### Tools Exposed

- **`search`** — Fast keyword search (FTS5 + BM25)
- **`semantic_search`** — Vector similarity search
- **`query`** — Hybrid search (keyword + semantic, RRF fusion)
- **`stats`** — Index statistics

## Architecture

```
src/
  cli.ts       — CLI entry point
  sync.ts      — Git clone/pull + change detection
  chunker.ts   — Code-aware file splitting
  indexer.ts    — SQLite FTS5 + vector storage
  embedder.ts  — Embedding provider (OpenAI API, swappable)
  search.ts    — Search engine (keyword, semantic, hybrid)
  server.ts    — MCP server (stdio transport)
```

## Supported Languages

TypeScript, JavaScript, Python, Rust, Go, Java, Kotlin, C/C++, Ruby, PHP, Swift, C#, Solidity, SQL, Markdown, YAML, TOML, Shell, GraphQL, Protobuf, Terraform

## Re-indexing

Run `index` again on the same repo — it only re-indexes files whose content hash changed:

```bash
bun run src/cli.ts index https://github.com/your-org/your-repo --embed
# ✅ Indexed 3 files, skipped 97 unchanged
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | For semantic search | OpenAI API key for embeddings |
| `EMBEDDING_BASE_URL` | Optional | Custom OpenAI-compatible endpoint (Ollama, vLLM) |
| `CODEBASE_RAG_DATA` | Optional | Data directory (default: `./data`) |

## Auto-sync (optional)

Set up a cron or GitHub webhook to re-index on push:

```bash
# Cron: re-index every 15 minutes
*/15 * * * * cd /path/to/codebase-rag && bun run src/cli.ts index https://github.com/your-org/your-repo --embed
```

## Stack

- **Runtime**: Bun
- **Database**: SQLite (bun:sqlite) with FTS5
- **Embeddings**: OpenAI text-embedding-3-small (swappable)
- **MCP**: @modelcontextprotocol/sdk
- **Zero external infrastructure** — single SQLite file, no Postgres/Pinecone/etc.
