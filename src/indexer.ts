import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync } from "fs";
import type { Chunk } from "./chunker";

export class Indexer {
  private db: Database;
  private dimensions: number;

  constructor(dataDir: string, dimensions: number = 1536) {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "index.sqlite");
    this.db = new Database(dbPath, { create: true });
    this.dimensions = dimensions;
    this.init();
  }

  private init() {
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");

    // Core documents table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        language TEXT,
        indexed_at TEXT DEFAULT (datetime('now')),
        UNIQUE(repo, file_path)
      )
    `);

    // Chunks table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        start_line INTEGER,
        end_line INTEGER,
        content TEXT NOT NULL,
        chunk_type TEXT DEFAULT 'code',
        UNIQUE(doc_id, start_line)
      )
    `);

    // FTS5 full-text search index
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content,
        file_path,
        tokenize='porter unicode61'
      )
    `);

    // Vector storage - store as raw blobs
    this.db.run(`
      CREATE TABLE IF NOT EXISTS vectors (
        chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL
      )
    `);
  }

  /**
   * Check if a file has changed since last index.
   */
  hasChanged(repo: string, filePath: string, hash: string): boolean {
    const row = this.db
      .query("SELECT file_hash FROM documents WHERE repo = ? AND file_path = ?")
      .get(repo, filePath) as { file_hash: string } | null;
    return !row || row.file_hash !== hash;
  }

  /**
   * Index chunks from a single file.
   */
  indexFile(repo: string, filePath: string, hash: string, chunks: Chunk[]) {
    const tx = this.db.transaction(() => {
      // Upsert document
      this.db
        .query(
          `INSERT INTO documents (repo, file_path, file_hash, language, indexed_at)
           VALUES (?1, ?2, ?3, ?4, datetime('now'))
           ON CONFLICT(repo, file_path) DO UPDATE SET
             file_hash = excluded.file_hash,
             language = excluded.language,
             indexed_at = datetime('now')`,
        )
        .run(repo, filePath, hash, chunks[0]?.language || "unknown");

      const doc = this.db
        .query("SELECT id FROM documents WHERE repo = ? AND file_path = ?")
        .get(repo, filePath) as { id: number };

      // Clear old chunks + vectors for this doc
      this.db
        .query("DELETE FROM vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = ?)")
        .run(doc.id);

      // Get old chunk rowids to remove from FTS
      const oldChunks = this.db
        .query("SELECT rowid FROM chunks WHERE doc_id = ?")
        .all(doc.id) as { rowid: number }[];

      for (const old of oldChunks) {
        this.db.query("DELETE FROM chunks_fts WHERE rowid = ?").run(old.rowid);
      }

      this.db.query("DELETE FROM chunks WHERE doc_id = ?").run(doc.id);

      // Insert new chunks
      for (const chunk of chunks) {
        const relPath = chunk.filePath.replace(/^.*\/repos\/[^/]+\//, "");
        const result = this.db
          .query(
            `INSERT INTO chunks (doc_id, start_line, end_line, content, chunk_type)
             VALUES (?1, ?2, ?3, ?4, ?5)`,
          )
          .run(doc.id, chunk.startLine, chunk.endLine, chunk.content, chunk.type);

        // Get the rowid of the inserted chunk
        const inserted = this.db
          .query("SELECT last_insert_rowid() as id")
          .get() as { id: number };

        this.db
          .query("INSERT INTO chunks_fts (rowid, content, file_path) VALUES (?1, ?2, ?3)")
          .run(inserted.id, chunk.content, relPath);
      }
    });

    tx();
  }

  /**
   * Store embedding vectors for chunks of a file.
   */
  storeVectors(repo: string, filePath: string, vectors: number[][]) {
    const doc = this.db
      .query("SELECT id FROM documents WHERE repo = ? AND file_path = ?")
      .get(repo, filePath) as { id: number } | null;

    if (!doc) return;

    const chunks = this.db
      .query("SELECT id FROM chunks WHERE doc_id = ? ORDER BY start_line ASC")
      .all(doc.id) as { id: number }[];

    const tx = this.db.transaction(() => {
      for (let i = 0; i < Math.min(chunks.length, vectors.length); i++) {
        const buf = Buffer.alloc(vectors[i].length * 4);
        for (let j = 0; j < vectors[i].length; j++) {
          buf.writeFloatLE(vectors[i][j], j * 4);
        }
        this.db
          .query("INSERT OR REPLACE INTO vectors (chunk_id, embedding) VALUES (?1, ?2)")
          .run(chunks[i].id, buf);
      }
    });

    tx();
  }

  /**
   * FTS5 keyword search with BM25 ranking.
   */
  keywordSearch(query: string, limit: number = 10): SearchResult[] {
    // Build FTS query with prefix matching
    const terms = query
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .map((t) => `"${t.replace(/"/g, "")}"*`)
      .join(" AND ");

    if (!terms) return [];

    try {
      const rows = this.db
        .query(
          `SELECT
            c.id as chunk_id,
            c.content,
            c.start_line,
            c.end_line,
            c.chunk_type,
            d.file_path,
            d.repo,
            d.language,
            bm25(chunks_fts, 1.0, 5.0) as score
          FROM chunks_fts f
          JOIN chunks c ON c.rowid = f.rowid
          JOIN documents d ON d.id = c.doc_id
          WHERE chunks_fts MATCH ?1
          ORDER BY score ASC
          LIMIT ?2`,
        )
        .all(terms, limit) as RawSearchRow[];

      return rows.map((r) => ({
        filePath: r.file_path.replace(/^.*\/repos\/[^/]+\//, ""),
        content: r.content,
        startLine: r.start_line,
        endLine: r.end_line,
        language: r.language,
        repo: r.repo,
        score: Math.abs(r.score) / (1 + Math.abs(r.score)), // normalize to 0-1
        method: "keyword" as const,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Vector similarity search (cosine distance).
   */
  vectorSearch(queryEmbedding: number[], limit: number = 10): SearchResult[] {
    const rows = this.db
      .query(
        `SELECT
          v.chunk_id,
          v.embedding,
          c.content,
          c.start_line,
          c.end_line,
          c.chunk_type,
          d.file_path,
          d.repo,
          d.language
        FROM vectors v
        JOIN chunks c ON c.id = v.chunk_id
        JOIN documents d ON d.id = c.doc_id`,
      )
      .all() as (RawSearchRow & { embedding: Buffer })[];

    const scored = rows
      .map((r) => {
        const vec = bufferToFloat32(r.embedding);
        const sim = cosineSimilarity(queryEmbedding, vec);
        return { ...r, score: sim };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map((r) => ({
      filePath: r.file_path.replace(/^.*\/repos\/[^/]+\//, ""),
      content: r.content,
      startLine: r.start_line,
      endLine: r.end_line,
      language: r.language,
      repo: r.repo,
      score: r.score,
      method: "semantic" as const,
    }));
  }

  /**
   * Hybrid search: combine keyword + vector results via RRF.
   */
  hybridSearch(
    query: string,
    queryEmbedding: number[] | null,
    limit: number = 10,
  ): SearchResult[] {
    const keywordResults = this.keywordSearch(query, limit * 2);

    if (!queryEmbedding) {
      return keywordResults.slice(0, limit);
    }

    const vectorResults = this.vectorSearch(queryEmbedding, limit * 2);

    // Reciprocal Rank Fusion
    const scores = new Map<string, { score: number; result: SearchResult }>();
    const k = 60;

    for (let i = 0; i < keywordResults.length; i++) {
      const key = `${keywordResults[i].filePath}:${keywordResults[i].startLine}`;
      const rrfScore = 1 / (k + i + 1);
      scores.set(key, {
        score: rrfScore,
        result: { ...keywordResults[i], method: "hybrid" },
      });
    }

    for (let i = 0; i < vectorResults.length; i++) {
      const key = `${vectorResults[i].filePath}:${vectorResults[i].startLine}`;
      const rrfScore = 1 / (k + i + 1);
      const existing = scores.get(key);
      if (existing) {
        existing.score += rrfScore;
        existing.result.method = "hybrid";
      } else {
        scores.set(key, {
          score: rrfScore,
          result: { ...vectorResults[i], method: "hybrid" },
        });
      }
    }

    return Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ ...s.result, score: s.score }));
  }

  /**
   * Get stats about the index.
   */
  getStats(): IndexStats {
    const docs = this.db
      .query("SELECT COUNT(*) as count FROM documents")
      .get() as { count: number };
    const chunks = this.db
      .query("SELECT COUNT(*) as count FROM chunks")
      .get() as { count: number };
    const vectors = this.db
      .query("SELECT COUNT(*) as count FROM vectors")
      .get() as { count: number };
    const repos = this.db
      .query("SELECT DISTINCT repo FROM documents")
      .all() as { repo: string }[];

    return {
      totalFiles: docs.count,
      totalChunks: chunks.count,
      totalVectors: vectors.count,
      repos: repos.map((r) => r.repo),
    };
  }

  close() {
    this.db.close();
  }
}

// Helper types
interface RawSearchRow {
  chunk_id: number;
  content: string;
  start_line: number;
  end_line: number;
  chunk_type: string;
  file_path: string;
  repo: string;
  language: string;
  score: number;
}

export interface SearchResult {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  repo: string;
  score: number;
  method: "keyword" | "semantic" | "hybrid";
}

export interface IndexStats {
  totalFiles: number;
  totalChunks: number;
  totalVectors: number;
  repos: string[];
}

// Vector math helpers
function bufferToFloat32(buf: Buffer): number[] {
  const arr: number[] = [];
  for (let i = 0; i < buf.length; i += 4) {
    arr.push(buf.readFloatLE(i));
  }
  return arr;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
