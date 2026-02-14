#!/usr/bin/env bun

import { syncRepo, filterIndexableFiles, hashFile } from "./sync";
import { chunkFile } from "./chunker";
import { Indexer } from "./indexer";
import { createEmbedder } from "./embedder";
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
      await cmdServe(args);
      break;
    default:
      printUsage();
  }
}

async function cmdIndex(args: string[]) {
  if (args.length === 0) {
    console.error("Usage: codebase-rag index <github-repo-url> [--no-embed]");
    process.exit(1);
  }

  const repoUrl = args[0];
  const skipEmbed = args.includes("--no-embed");

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

  // Embed by default (local model, no API key needed)
  if (!skipEmbed && allChunks.length > 0) {
    console.log(`\n🧠 Generating embeddings (local model, no API key needed)...`);
    const embedder = createEmbedder();
    await embedder.init();

    let totalChunks = 0;
    for (const { filePath, chunks } of allChunks) {
      const texts = chunks.map((c) => c.content);
      try {
        const vectors = await embedder.embed(texts);
        indexer.storeVectors(repoName, filePath, vectors);
        totalChunks += chunks.length;
        const relPath = filePath.replace(/^.*\/repos\/[^/]+\//, "");
        process.stderr.write(`  Embedded ${relPath} (${chunks.length} chunks)\n`);
      } catch (e: any) {
        console.error(`  Failed to embed ${filePath}: ${e.message}`);
      }
    }
    console.log(`✅ Embedded ${totalChunks} chunks across ${allChunks.length} files`);
  } else if (skipEmbed) {
    console.log(`⏭️  Skipping embeddings (--no-embed flag)`);
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
  await embedder.init();
  const engine = new SearchEngine(indexer, embedder);

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

async function cmdServe(args: string[]) {
  const isHttp = args.includes("--http");
  const portFlag = args.find((a) => a.startsWith("--port="));
  const port = portFlag ? parseInt(portFlag.split("=")[1]) : parseInt(process.env.PORT || "3100");

  if (isHttp) {
    const { startHttpServer } = await import("./server");
    await startHttpServer(port);
  } else {
    const { startStdioServer } = await import("./server");
    await startStdioServer();
  }
}

function printUsage() {
  console.log(`
codebase-rag — Index and search any GitHub repository

COMMANDS:
  index <repo-url> [--no-embed]  Clone/pull repo, index + embed it
                                   --no-embed: skip vector embeddings

  search <query>               Fast keyword search (FTS5 + BM25)
  vsearch <query>              Semantic vector search
  query <query>                Hybrid search (keyword + semantic)

  stats                        Show index statistics

  serve                        Start MCP server (stdio, for local use)
  serve --http [--port=3100]   Start MCP server (HTTP, for remote access)

ENVIRONMENT:
  OPENAI_API_KEY               Optional: use OpenAI instead of local model
  EMBEDDING_BASE_URL           Optional: custom OpenAI-compatible endpoint
  EMBEDDING_MODEL              Optional: HuggingFace model (default: Xenova/all-MiniLM-L6-v2)
  CODEBASE_RAG_DATA            Data directory (default: ./data)
  PORT                         HTTP server port (default: 3100)

EXAMPLES:
  # Index a repo (includes embeddings, no API key needed!)
  codebase-rag index https://github.com/your-org/your-repo

  # Index without embeddings (keyword search only)
  codebase-rag index https://github.com/your-org/your-repo --no-embed

  # Search
  codebase-rag search "place order"
  codebase-rag query "how does authentication work"

  # Start MCP server (local, stdio)
  codebase-rag serve

  # Start MCP server (remote, HTTP)
  codebase-rag serve --http --port=3100
`);
}

main().catch((e) => {
  console.error("Error:", e.message || e);
  process.exit(1);
});
