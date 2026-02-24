/**
 * OpenRouter AI Service for Qar
 * 
 * Provides AI-powered movie/TV show recommendations based on the user's library.
 * Uses OpenRouter API with structured output for consistent responses.
 * Includes caching to minimize API costs.
 */

import axios, { AxiosInstance, AxiosError } from "axios";
import crypto from "crypto";
import { Setting } from "../../models";
import { recommendationsSchema, Recommendation, RecommendationsResponse } from "./schemas";
import { RECOMMENDATIONS_SYSTEM_PROMPT, buildRecommendationsUserPrompt } from "./prompts";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "qwen/qwen3-8b";

// Cache TTL: 24 hours
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_SETTING_KEY = "ai_recommendations_cache";
const CACHE_HASH_KEY = "ai_recommendations_library_hash";
const CACHE_TIMESTAMP_KEY = "ai_recommendations_timestamp";

// Only include reasoning parameter for models that support it
function getReasoningParams(model: string): Record<string, any> {
  return model.startsWith("qwen/") ? { reasoning: { enabled: false } } : {};
}

// Parse JSON robustly — handles extra text before/after JSON or truncated output
function parseJsonResponse(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error(`Failed to parse JSON from response: ${content.slice(0, 200)}`);
  }
}

/**
 * Retry wrapper with exponential backoff for transient failures.
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries: number = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const axiosErr = error as AxiosError<any>;
      const status = axiosErr.response?.status;

      // Provider-specific 400 errors — retry
      if (status === 400 && axiosErr.response?.data?.error?.metadata?.provider_name && attempt < maxRetries) {
        const delay = 2000 * (attempt + 1);
        console.log(`[openrouter] Provider error, retrying (${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (status === 429 && attempt < maxRetries) {
        const retryAfter = parseInt(axiosErr.response?.headers?.["retry-after"] || "0") * 1000;
        const delay = Math.max(retryAfter, 3000 * Math.pow(2, attempt));
        console.log(`[openrouter] Rate limited, retry in ${delay}ms (${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (attempt < maxRetries && status && status >= 500) {
        const delay = 2000 * Math.pow(2, attempt);
        console.log(`[openrouter] Server error ${status}, retry in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      throw error;
    }
  }
  throw new Error("Max retries exceeded");
}

export class OpenRouterService {
  private apiKey: string = "";
  private model: string = DEFAULT_MODEL;
  private client: AxiosInstance | null = null;

  constructor() {
    // Initialize from environment variables
    this.apiKey = process.env.OPENROUTER_API_KEY || "";
    this.model = process.env.OPENROUTER_CHAT_MODEL || DEFAULT_MODEL;
  }

  /**
   * Initialize settings from database (called at startup).
   */
  async initializeFromDatabase(): Promise<void> {
    try {
      const apiKeySetting = await Setting.findOne({ where: { key: "openrouterApiKey" } });
      if (apiKeySetting?.value) {
        this.apiKey = apiKeySetting.value;
      }

      const modelSetting = await Setting.findOne({ where: { key: "openrouterModel" } });
      if (modelSetting?.value) {
        this.model = modelSetting.value;
      }

      this.rebuildClient();
    } catch (error) {
      console.error("[openrouter] Failed to initialize from database:", error);
    }
  }

  private rebuildClient(): void {
    if (!this.apiKey) {
      this.client = null;
      return;
    }

    this.client = axios.create({
      baseURL: OPENROUTER_API_URL,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://qar.local",
        "X-Title": "Qar",
      },
      timeout: 120000,
    });
  }

  /**
   * Check if the service is configured with an API key.
   */
  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Update the API key (from settings).
   */
  setApiKey(key: string): void {
    this.apiKey = key;
    this.rebuildClient();
  }

  /**
   * Update the model (from settings).
   */
  setModel(model: string): void {
    this.model = model || DEFAULT_MODEL;
  }

  /**
   * Get the current model.
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Test the API connection.
   */
  async testConnection(): Promise<boolean> {
    if (!this.client) return false;

    try {
      const response = await this.client.post("/chat/completions", {
        model: this.model,
        messages: [{ role: "user", content: "Say 'ok'" }],
        ...getReasoningParams(this.model),
        max_tokens: 10,
      });
      return response.data.choices && response.data.choices.length > 0;
    } catch (error: any) {
      console.error("[openrouter] Connection test failed:", error?.message || error);
      return false;
    }
  }

  /**
   * Generate a hash of the library contents for cache invalidation.
   */
  private hashLibrary(library: Array<{ title: string; year?: number; type: "movie" | "tv" }>): string {
    const sorted = [...library].sort((a, b) => a.title.localeCompare(b.title));
    const content = JSON.stringify(sorted);
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  /**
   * Get cached recommendations if still valid.
   */
  async getCachedRecommendations(
    libraryHash: string
  ): Promise<Recommendation[] | null> {
    try {
      const [cachedHash, cachedTimestamp, cachedData] = await Promise.all([
        Setting.findOne({ where: { key: CACHE_HASH_KEY } }),
        Setting.findOne({ where: { key: CACHE_TIMESTAMP_KEY } }),
        Setting.findOne({ where: { key: CACHE_SETTING_KEY } }),
      ]);

      if (!cachedHash || !cachedTimestamp || !cachedData) return null;

      // Check if library has changed
      if (cachedHash.value !== libraryHash) {
        console.log("[openrouter] Cache miss: library changed");
        return null;
      }

      // Check if cache has expired
      const timestamp = parseInt(cachedTimestamp.value, 10);
      if (Date.now() - timestamp > CACHE_TTL_MS) {
        console.log("[openrouter] Cache miss: expired");
        return null;
      }

      console.log("[openrouter] Cache hit: returning cached recommendations");
      return JSON.parse(cachedData.value);
    } catch (error) {
      console.error("[openrouter] Cache read error:", error);
      return null;
    }
  }

  /**
   * Save recommendations to cache.
   */
  private async cacheRecommendations(
    libraryHash: string,
    recommendations: Recommendation[]
  ): Promise<void> {
    try {
      await Promise.all([
        Setting.upsert({ key: CACHE_HASH_KEY, value: libraryHash }),
        Setting.upsert({ key: CACHE_TIMESTAMP_KEY, value: String(Date.now()) }),
        Setting.upsert({ key: CACHE_SETTING_KEY, value: JSON.stringify(recommendations) }),
      ]);
      console.log("[openrouter] Recommendations cached");
    } catch (error) {
      console.error("[openrouter] Cache write error:", error);
    }
  }

  /**
   * Clear the recommendations cache (e.g., when user wants fresh results).
   */
  async clearCache(): Promise<void> {
    try {
      await Setting.destroy({
        where: { key: [CACHE_SETTING_KEY, CACHE_HASH_KEY, CACHE_TIMESTAMP_KEY] },
      });
      console.log("[openrouter] Cache cleared");
    } catch (error) {
      console.error("[openrouter] Cache clear error:", error);
    }
  }

  /**
   * Check if valid cached recommendations exist for the given library.
   */
  async hasCachedRecommendations(
    library: Array<{ title: string; year?: number; type: "movie" | "tv" }>
  ): Promise<boolean> {
    const libraryHash = this.hashLibrary(library);
    const cached = await this.getCachedRecommendations(libraryHash);
    return cached !== null;
  }

  /**
   * Update the cached recommendations (e.g., after OMDB validation filters some out).
   */
  async updateCache(
    recommendations: Recommendation[],
    library: Array<{ title: string; year?: number; type: "movie" | "tv" }>
  ): Promise<void> {
    const libraryHash = this.hashLibrary(library);
    await this.cacheRecommendations(libraryHash, recommendations);
  }

  /**
   * Get AI-powered recommendations based on the user's library.
   * Uses caching to minimize API calls.
   * 
   * @param library - The user's current media library
   * @param forceRefresh - Skip cache and generate new recommendations
   * @returns Array of recommendations
   */
  async getRecommendations(
    library: Array<{ title: string; year?: number; type: "movie" | "tv" }>,
    forceRefresh: boolean = false
  ): Promise<Recommendation[]> {
    if (!this.client || !this.apiKey) {
      throw new Error("OpenRouter API key not configured");
    }

    if (library.length === 0) {
      return [];
    }

    const libraryHash = this.hashLibrary(library);

    // Check cache unless force refresh
    if (!forceRefresh) {
      const cached = await this.getCachedRecommendations(libraryHash);
      if (cached) return cached;
    }

    console.log(`[openrouter] Generating recommendations for ${library.length} library items`);

    const userPrompt = buildRecommendationsUserPrompt(library);

    const result = await withRetry(async () => {
      const response = await this.client!.post("/chat/completions", {
        model: this.model,
        messages: [
          { role: "system", content: RECOMMENDATIONS_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: recommendationsSchema,
        ...getReasoningParams(this.model),
        plugins: [{ id: "response-healing" }],
        provider: { require_parameters: true },
        temperature: 0.7,
        max_tokens: 2048,
      });

      const parsed: RecommendationsResponse = parseJsonResponse(
        response.data.choices[0].message.content
      );
      
      // Clean up: strip year from titles if the LLM included it (e.g., "Movie Title (2004)" → "Movie Title")
      for (const rec of parsed.recommendations) {
        const yearSuffix = new RegExp(`\\s*\\(${rec.year}\\)\\s*$`);
        rec.title = rec.title.replace(yearSuffix, '').trim();
      }
      
      return parsed.recommendations;
    });

    // Filter out any items that are already in the library
    const libraryTitles = new Set(
      library.map((item) => item.title.toLowerCase())
    );
    const filtered = result.filter(
      (rec) => !libraryTitles.has(rec.title.toLowerCase())
    );

    // Cache the results
    await this.cacheRecommendations(libraryHash, filtered);

    return filtered;
  }
}

export const openRouterService = new OpenRouterService();
