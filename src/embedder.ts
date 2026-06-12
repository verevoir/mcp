import type { Embedder } from '@verevoir/recipes/engine';

// A zero-dependency embedder for the capability bin (STDIO-339). The embedding
// engine (index + cache + cosine) lives in @verevoir/recipes; recipes never
// bundles an embedder — the host injects one. The website injects a *local*
// model (@huggingface/transformers → onnxruntime, hundreds of MB). For this
// lean server we instead call a hosted **OpenAI-compatible** `/embeddings`
// endpoint over plain `fetch` (global in Node ≥20) — no SDK, no onnxruntime.
//
// It's not "more internet-needing" than we already are: `provision` already
// makes a network reasoning call for concern-tagging, and the corpus vectors
// are embedded once and cached on disk by recipes — per call it's a single
// short query embed. Provider-agnostic by design: point `AIGENCY_EMBEDDINGS_URL`
// at OpenAI, Mistral, DeepSeek, Voyage, or any OpenAI-compatible endpoint.
// (If offline / no-network capability retrieval ever matters, swap this for the
// heavier local embedder behind the same seam — STDIO-339.)

const DEFAULT_URL = 'https://api.openai.com/v1/embeddings';
const DEFAULT_MODEL = 'text-embedding-3-small';

export interface EmbeddingsConfig {
  apiKey: string | null;
  url: string;
  model: string;
}

/** Resolve the embeddings endpoint config from env. The key falls back to
 * `OPENAI_API_KEY` so an OpenAI user needs no extra var; the URL + model are
 * overridable to point at any OpenAI-compatible provider. */
export function embeddingsConfig(): EmbeddingsConfig {
  return {
    apiKey:
      process.env.AIGENCY_EMBEDDINGS_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || null,
    url: process.env.AIGENCY_EMBEDDINGS_URL?.trim() || DEFAULT_URL,
    model: process.env.AIGENCY_EMBEDDINGS_MODEL?.trim() || DEFAULT_MODEL,
  };
}

/** Build the fetch-based embedder, or `null` when no embeddings key is
 * configured — the caller then degrades to "practices only" rather than
 * failing. The `id` carries the model so recipes' vector cache invalidates
 * automatically when the model changes. */
export function fetchEmbedder(config: EmbeddingsConfig = embeddingsConfig()): Embedder | null {
  const { apiKey, url, model } = config;
  if (!apiKey) return null;
  return {
    id: `openai-compat:${model}`,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`embeddings request failed (${res.status}): ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        data?: { embedding: number[]; index: number }[];
      };
      const data = json.data ?? [];
      // Sort by `index` so the vectors line up with the input order regardless
      // of how the provider returns them.
      return [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}
