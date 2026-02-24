import { OpenRouterService } from "../services/ai/openrouter";
import { buildRecommendationsUserPrompt, RECOMMENDATIONS_SYSTEM_PROMPT } from "../services/ai/prompts";
import { recommendationsSchema } from "../services/ai/schemas";
import { Setting } from "../models";

/**
 * Tests for AI Recommendation Features
 * 
 * These tests verify the OpenRouter service, prompt generation,
 * structured output schemas, and caching behavior.
 * 
 * Live API tests require a valid OPENROUTER_API_KEY in the environment.
 */

const isLiveTestEnabled = () => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  return apiKey && apiKey.length > 10 && apiKey.startsWith("sk-or-");
};

describe("AI Recommendations - Prompts", () => {
  it("should generate a user prompt with movies and TV shows", () => {
    const library = [
      { title: "The Matrix", year: 1999, type: "movie" as const },
      { title: "Inception", year: 2010, type: "movie" as const },
      { title: "Breaking Bad", year: 2008, type: "tv" as const },
    ];

    const prompt = buildRecommendationsUserPrompt(library);

    expect(prompt).toContain("The Matrix (1999)");
    expect(prompt).toContain("Inception (2010)");
    expect(prompt).toContain("Breaking Bad (2008)");
    expect(prompt).toContain("Movies:");
    expect(prompt).toContain("TV Shows:");
    expect(prompt).toContain("recommend 10-15");
  });

  it("should handle empty library", () => {
    const prompt = buildRecommendationsUserPrompt([]);
    expect(prompt).toContain("library is empty");
  });

  it("should handle movies-only library", () => {
    const library = [
      { title: "Blade Runner", year: 1982, type: "movie" as const },
    ];

    const prompt = buildRecommendationsUserPrompt(library);
    expect(prompt).toContain("Movies:");
    expect(prompt).toContain("Blade Runner (1982)");
    expect(prompt).not.toContain("TV Shows:");
  });

  it("should have a system prompt that instructs filtering", () => {
    expect(RECOMMENDATIONS_SYSTEM_PROMPT).toContain("NOT already in the user's library");
    expect(RECOMMENDATIONS_SYSTEM_PROMPT).toContain("release year");
  });
});

describe("AI Recommendations - Schema", () => {
  it("should have the correct schema structure", () => {
    expect(recommendationsSchema.type).toBe("json_schema");
    expect(recommendationsSchema.json_schema.name).toBe("media_recommendations");
    expect(recommendationsSchema.json_schema.strict).toBe(true);

    const schema = recommendationsSchema.json_schema.schema;
    expect(schema.properties.recommendations).toBeDefined();
    expect(schema.properties.recommendations.type).toBe("array");

    const itemSchema = schema.properties.recommendations.items;
    expect(itemSchema.properties.title).toBeDefined();
    expect(itemSchema.properties.year).toBeDefined();
    expect(itemSchema.properties.type).toBeDefined();
    expect(itemSchema.properties.reason).toBeDefined();
    expect(itemSchema.required).toContain("title");
    expect(itemSchema.required).toContain("year");
    expect(itemSchema.required).toContain("type");
    expect(itemSchema.required).toContain("reason");
  });

  it("should restrict type to movie or tv", () => {
    const typeSchema = recommendationsSchema.json_schema.schema.properties.recommendations.items.properties.type;
    expect(typeSchema.enum).toEqual(["movie", "tv"]);
  });
});

describe("AI Recommendations - Service", () => {
  let service: OpenRouterService;

  beforeEach(() => {
    service = new OpenRouterService();
  });

  it("should not be configured without an API key", () => {
    // Clear env var for this test
    const originalKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    
    const freshService = new OpenRouterService();
    expect(freshService.isConfigured()).toBe(false);
    
    // Restore
    if (originalKey) process.env.OPENROUTER_API_KEY = originalKey;
  });

  it("should be configured when API key is set via setApiKey", () => {
    service.setApiKey("sk-or-test-key");
    expect(service.isConfigured()).toBe(true);
  });

  it("should use default model when none specified", () => {
    expect(service.getModel()).toBe(
      process.env.OPENROUTER_CHAT_MODEL || "qwen/qwen3-8b"
    );
  });

  it("should allow changing the model", () => {
    service.setModel("anthropic/claude-3-haiku");
    expect(service.getModel()).toBe("anthropic/claude-3-haiku");
  });

  it("should fall back to default model when empty string given", () => {
    service.setModel("");
    expect(service.getModel()).toBe("qwen/qwen3-8b");
  });

  it("should throw when getting recommendations without API key", async () => {
    const freshService = new OpenRouterService();
    // Explicitly clear the key
    freshService.setApiKey("");

    await expect(
      freshService.getRecommendations([
        { title: "Test", year: 2024, type: "movie" },
      ])
    ).rejects.toThrow("not configured");
  });

  it("should return empty array for empty library", async () => {
    service.setApiKey("sk-or-test-key");
    const result = await service.getRecommendations([]);
    expect(result).toEqual([]);
  });
});

describe("AI Recommendations - Caching", () => {
  it("should store and retrieve recommendations from cache", async () => {
    const service = new OpenRouterService();
    service.setApiKey("sk-or-test-key");

    // Manually store cache entries
    const testRecommendations = [
      { title: "Test Movie", year: 2024, type: "movie" as const, reason: "Great film" },
    ];

    const crypto = require("crypto");
    const library = [{ title: "Existing Movie", year: 2020, type: "movie" }];
    const sorted = [...library].sort((a: any, b: any) => a.title.localeCompare(b.title));
    const hash = crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);

    await Promise.all([
      Setting.upsert({ key: "ai_recommendations_library_hash", value: hash }),
      Setting.upsert({ key: "ai_recommendations_timestamp", value: String(Date.now()) }),
      Setting.upsert({ key: "ai_recommendations_cache", value: JSON.stringify(testRecommendations) }),
    ]);

    const cached = await service.getCachedRecommendations(hash);
    expect(cached).not.toBeNull();
    expect(cached).toHaveLength(1);
    expect(cached![0].title).toBe("Test Movie");
  });

  it("should return null for expired cache", async () => {
    const service = new OpenRouterService();

    const crypto = require("crypto");
    const hash = "test-hash-expired";

    // Set timestamp to 25 hours ago (cache TTL is 24h)
    const expiredTimestamp = Date.now() - 25 * 60 * 60 * 1000;

    await Promise.all([
      Setting.upsert({ key: "ai_recommendations_library_hash", value: hash }),
      Setting.upsert({ key: "ai_recommendations_timestamp", value: String(expiredTimestamp) }),
      Setting.upsert({ key: "ai_recommendations_cache", value: "[]" }),
    ]);

    const cached = await service.getCachedRecommendations(hash);
    expect(cached).toBeNull();
  });

  it("should return null when library hash changes", async () => {
    const service = new OpenRouterService();

    await Promise.all([
      Setting.upsert({ key: "ai_recommendations_library_hash", value: "old-hash" }),
      Setting.upsert({ key: "ai_recommendations_timestamp", value: String(Date.now()) }),
      Setting.upsert({ key: "ai_recommendations_cache", value: "[]" }),
    ]);

    const cached = await service.getCachedRecommendations("new-hash");
    expect(cached).toBeNull();
  });

  it("should clear cache successfully", async () => {
    const service = new OpenRouterService();

    await Setting.upsert({ key: "ai_recommendations_cache", value: "test" });
    await service.clearCache();

    const setting = await Setting.findOne({ where: { key: "ai_recommendations_cache" } });
    expect(setting).toBeNull();
  });
});

describe("AI Recommendations - Live API", () => {
  it("should test connection successfully with valid API key", async () => {
    if (!isLiveTestEnabled()) {
      console.log("Skipping live OpenRouter test - no API key configured");
      return;
    }

    const service = new OpenRouterService();
    // API key comes from environment
    const connected = await service.testConnection();
    expect(connected).toBe(true);
  });

  it("should generate recommendations for a sample library", async () => {
    if (!isLiveTestEnabled()) {
      console.log("Skipping live OpenRouter test - no API key configured");
      return;
    }

    const service = new OpenRouterService();

    const library = [
      { title: "The Matrix", year: 1999, type: "movie" as const },
      { title: "Inception", year: 2010, type: "movie" as const },
      { title: "Interstellar", year: 2014, type: "movie" as const },
      { title: "Breaking Bad", year: 2008, type: "tv" as const },
    ];

    // Force refresh to bypass any cache
    const recommendations = await service.getRecommendations(library, true);

    expect(recommendations).toBeDefined();
    expect(Array.isArray(recommendations)).toBe(true);
    expect(recommendations.length).toBeGreaterThan(0);

    // Verify each recommendation has the required fields
    for (const rec of recommendations) {
      expect(rec.title).toBeDefined();
      expect(typeof rec.title).toBe("string");
      expect(rec.year).toBeDefined();
      expect(typeof rec.year).toBe("number");
      expect(["movie", "tv"]).toContain(rec.type);
      expect(rec.reason).toBeDefined();
      expect(typeof rec.reason).toBe("string");
    }

    // Verify none of the recommendations are in the library
    const libraryTitles = library.map((l) => l.title.toLowerCase());
    for (const rec of recommendations) {
      expect(libraryTitles).not.toContain(rec.title.toLowerCase());
    }

    console.log(`Generated ${recommendations.length} recommendations:`);
    for (const rec of recommendations.slice(0, 5)) {
      console.log(`  - ${rec.title} (${rec.year}) [${rec.type}]: ${rec.reason}`);
    }
  }, 60000); // Allow 60 seconds for API call
});
