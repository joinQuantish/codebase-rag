/**
 * Embedding provider abstraction.
 * MVP uses OpenAI text-embedding-3-small.
 * Can swap to local GGUF model later.
 */

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
  modelName: string;
}

/**
 * OpenAI embedding provider - cheap and fast.
 * text-embedding-3-small: $0.02/1M tokens, 1536 dimensions
 */
export class OpenAIEmbedder implements EmbeddingProvider {
  private apiKey: string;
  private baseUrl: string;
  public dimensions = 1536;
  public modelName = "text-embedding-3-small";

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || "https://api.openai.com/v1";
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Process in batches of 100 (API limit is 2048)
    const batchSize = 100;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const resp = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelName,
          input: batch,
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`OpenAI embedding failed: ${resp.status} ${err}`);
      }

      const data = (await resp.json()) as {
        data: { embedding: number[]; index: number }[];
      };

      // Sort by index to maintain order
      const sorted = data.data.sort((a, b) => a.index - b.index);
      allEmbeddings.push(...sorted.map((d) => d.embedding));

      if (i + batchSize < texts.length) {
        // Rate limit courtesy
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    return allEmbeddings;
  }
}

/**
 * Placeholder for local embedding (e.g., via node-llama-cpp).
 * Would use EmbeddingGemma-300M GGUF like qmd does.
 */
export class LocalEmbedder implements EmbeddingProvider {
  public dimensions = 256;
  public modelName = "embeddinggemma-300m";

  async embed(texts: string[]): Promise<number[][]> {
    throw new Error(
      "Local embedding not implemented in MVP. Use OpenAI or set OPENAI_API_KEY.",
    );
  }
}

/**
 * Create an embedder based on available config.
 */
export function createEmbedder(): EmbeddingProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    return new OpenAIEmbedder(apiKey);
  }

  // Check for OpenAI-compatible endpoints (e.g., Ollama, vLLM)
  const baseUrl = process.env.EMBEDDING_BASE_URL;
  const key = process.env.EMBEDDING_API_KEY || "not-needed";
  if (baseUrl) {
    return new OpenAIEmbedder(key, baseUrl);
  }

  console.warn(
    "No OPENAI_API_KEY or EMBEDDING_BASE_URL set. Vector search will be unavailable.",
  );
  console.warn("Keyword search (FTS5) will still work.");
  return new LocalEmbedder();
}
