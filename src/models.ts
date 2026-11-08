// Shared model mapping between OpenAI-compatible and native Anthropic routes.
// Unknown model names pass through unchanged, so native Claude model IDs also work.

export const MODEL_MAP: Record<string, string> = {
  // OpenAI names → Claude
  "gpt-4o": "claude-sonnet-4-6",
  "gpt-4": "claude-sonnet-4-6",
  "gpt-4-turbo": "claude-sonnet-4-6",
  "gpt-3.5-turbo": "claude-haiku-4-5",
  // Claude names → self (explicit, for clarity)
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-haiku-4-5": "claude-haiku-4-5",
  // Embedding models → Ollama (nomic-embed-text)
  "text-embedding-ada-002": "nomic-embed-text",
  "text-embedding-3-small": "nomic-embed-text",
  "text-embedding-3-large": "nomic-embed-text",
  "nomic-embed-text": "nomic-embed-text",
};

// Local patch: only real Claude models available on a Max plan (verified 2026-11-07).
// GPT / embedding aliases still resolve via MODEL_MAP but are not advertised.
// claude-fable-5-1 is omitted: it needs separate usage credits, not plan quota.
export const AVAILABLE_MODELS = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
];

export function resolveModel(requested: string): string {
  return MODEL_MAP[requested] || requested;
}
