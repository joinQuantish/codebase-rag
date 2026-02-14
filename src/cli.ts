#!/usr/bin/env bun

import { syncRepo, filterIndexableFiles, hashFile } from "./sync";
import { chunkFile } from "./chunker";
import { Indexer } from "./indexer";
import { createEmbedder, type EmbeddingProvider } from "./embedder";
import { SearchEngine } from "./search";

const DATA_DIR = process.env.CODEBASE_RAG_DATA || "./data";

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "index":
      await cmdIndex(args);
      break;
    case "search":
      await cmdSearch(args, "keyword");
      break;
    case "vsearch":
      await cmdSearch(args, "semantic");
      break;
    case "query":
      await cmdSearch(args, "hybrid");
      break;
    case "stats":
      cmdStats();
      break;
    case "serve":
      await cmdServe();
      break;
    default:
      printUsage();
  }
}

async function cmdIndex(args: string[]) {
  if (args.length === 0) {
    console.error("Usage: codebase-rag index <github-repo-url> [--embed]");
    process.exit(1);
  }

  const repoUrl = args[0];
  const doEmbed = args.includes("--embed");

  console.log(`\n📦 Syncing ${repoUrl}...`);
  const sync = syncRepo(repoUrl, DATA_DIR);
  const repoName = sync.repoDir.split("/").pop()!;

  const files = filterIndexableFiles(sync.allFiles);
  console.log(`📂 Found ${files.length} indexable files (${sync.allFiles.length} total tracked)`);

  const indexer = new Indexer(DATA_DIR);
  let indexed = 0;
  let skipped = 0;
  const allChunks: { filePath: string; chunks: ReturnType<typeof chunkFile> }[] = [];

  for (const file of files) {
    const hash = hashFile(file);
    if (!sync.isNew && !indexer.hasChanged(repoName, file, hash)) {
      skipped++;
      continue;
    }

    const chunks = chunkFile(file);
    if (chunks.length === 0) continue;

    indexer.indexFile(repoName, file, hash, chunks);
    allChunks.push({ filePath: file, chunks });
    indexed++;
  }

  console.log(`✅ Indexed ${indexed} files, skipped ${skipped} unchanged`);

  // Embed if requested
  if (doEmbed) {
    console.log(`\n🧠 Generating embeddings...`);
    const embedder = createEmbedder();

    let totalChunks = 0;
    for (const { filePath, chunks } of allChunks) {
      const texts = chunks.map((c) => c.content);
      try {
        const vectors = await embedder.embed(texts);
        indexer.storeVectors(repoName, filePath, vectors);
        totalChunks += chunks.length;
        process.stderr.write(`  Embedded ${filePath.replace(/^.*\/repos\/[^/]+\//, "")} (${chunks.length} chunks)\n`);
      } catch (e: any) {
        console.error(`  Failed to embed ${filePath}: ${e.message}`);
      }
    }
    console.log(`✅ Embedded ${totalChunks} chunks across ${allChunks.length} files`);
  }

  const stats = indexer.getStats();
  console.log(`\n📊 Index: ${stats.totalFiles} files, ${stats.totalChunks} chunks, ${stats.totalVectors} vectors`);
  indexer.close();
}

async function cmdSearch(args: string[], mode: "keyword" | "semantic" | "hybrid") {
  const query = args.join(" ");
  if (!query) {
    console.error(`Usage: codebase-rag ${mode === "keyword" ? "search" : mode === "semantic" ? "vsearch" : "query"} <query>`);
    process.exit(1);
  }

  const indexer = new Indexer(DATA_DIR);
  const embedder = createEmbedder();
  const hasEmbedder = embedder.modelName !== "embeddinggemma-300m";
  const engine = new SearchEngine(indexer, hasEmbedder ? embedder : null);

  let results;
  const start = performance.now();

  switch (mode) {
    case "keyword":
      results = await engine.keyword(query);
      break;
    case "semantic":
      results = await engine.semantic(query);
      break;
    case "hybrid":
      results = await engine.hybrid(query);
      break;
  }

  const elapsed = (performance.now() - start).toFixed(0);

  console.log(`\n🔍 ${mode} search for "${query}" (${elapsed}ms, ${results.length} results)\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(`${i + 1}. ${r.filePath}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})`);
    // Show first 3 lines of content
    const preview = r.content.split("\n").slice(0, 4).join("\n");
    console.log(`   ${preview.replace(/\n/g, "\n   ")}`);
    console.log();
  }

  indexer.close();
}

function cmdStats() {
  const indexer = new Indexer(DATA_DIR);
  const stats = indexer.getStats();
  console.log(`\n📊 Codebase RAG Index`);
  console.log(`   Files:   ${stats.totalFiles}`);
  console.log(`   Chunks:  ${stats.totalChunks}`);
  console.log(`   Vectors: ${stats.totalVectors}`);
  console.log(`   Repos:   ${stats.repos.join(", ") || "none"}`);
  indexer.close();
}

async function cmdServe() {
  const { startServer } = await import("./server");
  await startServer();
}

function printUsage() {
  console.log(`
codebase-rag — Index and search any GitHub repository

COMMANDS:
  index <repo-url> [--embed]   Clone/pull repo and index it
                                 --embed: also generate vector embeddings

  search <query>               Fast keyword search (FTS5 + BM25)
  vsearch <query>              Semantic vector search
  query <query>                Hybrid search (keyword + semantic)

  stats                        Show index statistics
  serve                        Start MCP server (stdio transport)

ENVIRONMENT:
  OPENAI_API_KEY               Required for semantic/hybrid search
  EMBEDDING_BASE_URL           Custom OpenAI-compatible endpoint (e.g., Ollama)
  CODEBASE_RAG_DATA            Data directory (default: ./data)

EXAMPLES:
  # Index a repo (keyword search only — no API key needed)
  codebase-rag index https://github.com/joinQuantish/polymarket-mcp

  # Index with embeddings (needs OPENAI_API_KEY)
  codebase-rag index https://github.com/joinQuantish/polymarket-mcp --embed

  # Search
  codebase-rag search "place order"
  codebase-rag query "how does authentication work"

  # Start MCP server for Claude Code / Cursor
  codebase-rag serve
`);
}

main().catch((e) => {
  console.error("Error:", e.message || e);
  process.exit(1);
});
