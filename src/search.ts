import { Indexer, type SearchResult } from "./indexer";
import type { EmbeddingProvider } from "./embedder";

/**
 * High-level search interface that wraps the indexer + embedder.
 */
export class SearchEngine {
  constructor(
    private indexer: Indexer,
    private embedder: EmbeddingProvider | null,
  ) {}

  /**
   * Fast keyword search — no embedding needed.
   */
  async keyword(query: string, limit: number = 10): Promise<SearchResult[]> {
    return this.indexer.keywordSearch(query, limit);
  }

  /**
   * Semantic vector search — requires embedder.
   */
  async semantic(query: string, limit: number = 10): Promise<SearchResult[]> {
    if (!this.embedder) {
      throw new Error("No embedding provider available. Set OPENAI_API_KEY.");
    }
    const [embedding] = await this.embedder.embed([query]);
    return this.indexer.vectorSearch(embedding, limit);
  }

  /**
   * Hybrid search — keyword + semantic with RRF fusion.
   */
  async hybrid(query: string, limit: number = 10): Promise<SearchResult[]> {
    let queryEmbedding: number[] | null = null;
    if (this.embedder) {
      try {
        [queryEmbedding] = await this.embedder.embed([query]);
      } catch {
        // Fall back to keyword-only
      }
    }
    return this.indexer.hybridSearch(query, queryEmbedding, limit);
  }

  /**
   * Get index statistics.
   */
  stats() {
    return this.indexer.getStats();
  }
}
