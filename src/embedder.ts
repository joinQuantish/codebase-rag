/**
 * Embedding providers — local (default) and OpenAI (optional).
 * Local uses @huggingface/transformers with all-MiniLM-L6-v2 (ONNX, CPU).
 * No API keys, no GPU required.
 */

import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  init(): Promise<void>;
  dimensions: number;
  modelName: string;
}

/**
 * Local embedding using HuggingFace Transformers.js (ONNX Runtime on CPU).
 * Model: all-MiniLM-L6-v2 (22MB quantized, 384 dimensions, ~4ms/embed)
 * Auto-downloads on first use, cached in ~/.cache/huggingface/
 */
export class LocalEmbedder implements EmbeddingProvider {
  private extractor: FeatureExtractionPipeline | null = null;
  private model: string;
  public dimensions = 384;
  public modelName: string;

  constructor(model?: string) {
    this.model = model || "Xenova/all-MiniLM-L6-v2";
    this.modelName = this.model;
  }

  async init() {
    if (this.extractor) return;
    console.log(`Loading embedding model: ${this.model} (first run downloads ~22MB)...`);
    this.extractor = await pipeline("feature-extraction", this.model, {
      dtype: "q8",
    });
    console.log(`Embedding model loaded.`);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.extractor) await this.init();
    const results: number[][] = [];

    for (const text of texts) {
      // Truncate very long texts (model max is 512 tokens)
      const truncated = text.slice(0, 4000);
      const output = await this.extractor!(truncated, {
        pooling: "mean",
        normalize: true,
      });
      results.push(Array.from(output.data as Float32Array));
    }

    return results;
  }
}

/**
 * OpenAI embedding provider — optional, for higher quality or faster batch embedding.
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

  async init() {}

  async embed(texts: string[]): Promise<number[][]> {
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

      const sorted = data.data.sort((a, b) => a.index - b.index);
      allEmbeddings.push(...sorted.map((d) => d.embedding));

      if (i + batchSize < texts.length) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    return allEmbeddings;
  }
}

/**
 * Create an embedder. Defaults to local (no API key needed).
 * Set OPENAI_API_KEY to use OpenAI instead.
 */
export function createEmbedder(): EmbeddingProvider {
  // OpenAI if explicitly configured
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    console.log("Using OpenAI embeddings (text-embedding-3-small)");
    return new OpenAIEmbedder(apiKey);
  }

  const baseUrl = process.env.EMBEDDING_BASE_URL;
  if (baseUrl) {
    const key = process.env.EMBEDDING_API_KEY || "not-needed";
    console.log(`Using custom embedding endpoint: ${baseUrl}`);
    return new OpenAIEmbedder(key, baseUrl);
  }

  // Default: local embeddings, no API key needed
  const model = process.env.EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
  console.log(`Using local embeddings (${model}, CPU, no API key needed)`);
  return new LocalEmbedder(model);
}
