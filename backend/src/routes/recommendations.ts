import { Router } from "express";
import { MediaItem, TVShow, Setting } from "../models";
import { openRouterService } from "../services/ai";
import { Recommendation } from "../services/ai/schemas";
import { omdbService } from "../services/omdb";

const router = Router();

const DISMISSED_KEY = "ai_dismissed_recommendations";

// In-memory generation state
let generationInProgress = false;
let generationError: string | null = null;

/**
 * Get dismissed recommendation keys from the database.
 */
async function getDismissed(): Promise<Set<string>> {
  try {
    const setting = await Setting.findOne({ where: { key: DISMISSED_KEY } });
    if (setting?.value) {
      return new Set(JSON.parse(setting.value));
    }
  } catch {}
  return new Set();
}

/**
 * Save dismissed recommendation keys to the database.
 */
async function saveDismissed(dismissed: Set<string>): Promise<void> {
  await Setting.upsert({
    key: DISMISSED_KEY,
    value: JSON.stringify(Array.from(dismissed)),
  });
}

/**
 * Build the library from the database.
 */
async function buildLibrary(): Promise<Array<{ title: string; year?: number; type: "movie" | "tv" }>> {
  const [movies, tvShows] = await Promise.all([
    MediaItem.findAll({ where: { type: "movie" }, attributes: ["title", "year"] }),
    TVShow.findAll({ attributes: ["title", "year"] }),
  ]);

  const library: Array<{ title: string; year?: number; type: "movie" | "tv" }> = [];
  const seenTitles = new Set<string>();

  for (const movie of movies) {
    const key = movie.title.toLowerCase();
    if (!seenTitles.has(key)) {
      seenTitles.add(key);
      library.push({ title: movie.title, year: movie.year, type: "movie" });
    }
  }

  for (const show of tvShows) {
    const key = show.title.toLowerCase();
    if (!seenTitles.has(key)) {
      seenTitles.add(key);
      library.push({ title: show.title, year: show.year, type: "tv" });
    }
  }

  return library;
}

/**
 * Validate recommendations against OMDB, filtering out ones that can't be found.
 */
async function validateWithOmdb(recommendations: Recommendation[]): Promise<Recommendation[]> {
  const validated: Recommendation[] = [];

  for (let i = 0; i < recommendations.length; i += 5) {
    const batch = recommendations.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async (rec) => {
        try {
          const type = rec.type === "movie" ? "movie" : "series";
          const searchResults = await omdbService.search(rec.title, type as "movie" | "series");
          if (searchResults.length === 0) {
            const anyResults = await omdbService.search(rec.title);
            if (anyResults.length === 0) return null;
          }
          return rec;
        } catch {
          return rec;
        }
      })
    );
    validated.push(...results.filter((r): r is Recommendation => r !== null));
  }

  return validated;
}

/**
 * Run recommendation generation in the background.
 */
async function generateInBackground(library: Array<{ title: string; year?: number; type: "movie" | "tv" }>): Promise<void> {
  generationInProgress = true;
  generationError = null;

  try {
    let recommendations = await openRouterService.getRecommendations(library, true);

    // Validate against OMDB
    if (recommendations.length > 0) {
      const before = recommendations.length;
      recommendations = await validateWithOmdb(recommendations);
      if (recommendations.length < before) {
        console.log(`[recommendations] OMDB validation filtered ${before - recommendations.length} invalid items`);
      }
    }

    // Cache the validated results
    await openRouterService.updateCache(recommendations, library);
    console.log(`[recommendations] Background generation complete: ${recommendations.length} recommendations`);
  } catch (error: any) {
    console.error("[recommendations] Background generation failed:", error?.message || error);
    generationError = error?.message || "Generation failed";
  } finally {
    generationInProgress = false;
  }
}

// Get AI-powered recommendations
router.get("/", async (req, res) => {
  try {
    if (!openRouterService.isConfigured()) {
      return res.status(400).json({ error: "OpenRouter API key not configured", configured: false });
    }

    const forceRefresh = req.query.refresh === "true";
    const library = await buildLibrary();

    if (library.length === 0) {
      return res.json({ recommendations: [], status: "empty", message: "Add items to get recommendations" });
    }

    // If a refresh was requested, start background generation
    if (forceRefresh) {
      if (!generationInProgress) {
        generateInBackground(library);
      }
      return res.json({ recommendations: [], status: "generating" });
    }

    // Check if generation is in progress
    if (generationInProgress) {
      return res.json({ recommendations: [], status: "generating" });
    }

    // Check for generation error
    if (generationError) {
      const err = generationError;
      generationError = null;
      return res.status(500).json({ error: err, status: "error" });
    }

    // Try to get cached recommendations
    const hasCached = await openRouterService.hasCachedRecommendations(library);
    if (!hasCached) {
      // No cache — return empty with "ready" status; user must click refresh to generate
      return res.json({ recommendations: [], status: "ready" });
    }

    let recommendations = await openRouterService.getRecommendations(library, false);

    // Filter out dismissed and library items
    const dismissed = await getDismissed();
    const libraryTitles = new Set(library.map((item) => item.title.toLowerCase()));

    recommendations = recommendations.filter((rec) => {
      const key = `${rec.title}-${rec.year}`;
      if (dismissed.has(key)) return false;
      if (libraryTitles.has(rec.title.toLowerCase())) return false;
      return true;
    });

    res.json({ recommendations, status: "ready", librarySize: library.length });
  } catch (error: any) {
    console.error("Recommendations error:", error?.message || error);
    res.status(500).json({ error: "Failed to get recommendations" });
  }
});

// Dismiss a recommendation
router.post("/dismiss", async (req, res) => {
  try {
    const { title, year } = req.body;
    if (!title || !year) {
      return res.status(400).json({ error: "title and year are required" });
    }

    const dismissed = await getDismissed();
    dismissed.add(`${title}-${year}`);
    await saveDismissed(dismissed);

    res.json({ success: true });
  } catch (error) {
    console.error("Dismiss error:", error);
    res.status(500).json({ error: "Failed to dismiss recommendation" });
  }
});

// Restore a dismissed recommendation
router.post("/restore", async (req, res) => {
  try {
    const { title, year } = req.body;
    if (!title || !year) {
      return res.status(400).json({ error: "title and year are required" });
    }

    const dismissed = await getDismissed();
    dismissed.delete(`${title}-${year}`);
    await saveDismissed(dismissed);

    res.json({ success: true });
  } catch (error) {
    console.error("Restore error:", error);
    res.status(500).json({ error: "Failed to restore recommendation" });
  }
});

// Restore all dismissed recommendations
router.post("/restore-all", async (req, res) => {
  try {
    await saveDismissed(new Set());
    res.json({ success: true });
  } catch (error) {
    console.error("Restore all error:", error);
    res.status(500).json({ error: "Failed to restore recommendations" });
  }
});

// Get dismissed recommendations
router.get("/dismissed", async (req, res) => {
  try {
    const dismissed = await getDismissed();
    res.json({ dismissed: Array.from(dismissed) });
  } catch (error) {
    console.error("Get dismissed error:", error);
    res.status(500).json({ error: "Failed to get dismissed recommendations" });
  }
});

// Clear recommendations cache
router.post("/clear-cache", async (req, res) => {
  try {
    await openRouterService.clearCache();
    res.json({ success: true, message: "Recommendations cache cleared" });
  } catch (error) {
    console.error("Clear cache error:", error);
    res.status(500).json({ error: "Failed to clear cache" });
  }
});

// Test OpenRouter connection
router.get("/test", async (req, res) => {
  try {
    if (!openRouterService.isConfigured()) {
      return res.json({ success: false, message: "API key not configured" });
    }

    const success = await openRouterService.testConnection();
    res.json({
      success,
      message: success ? "Connection successful" : "Connection failed",
      model: openRouterService.getModel(),
    });
  } catch (error: any) {
    res.json({ success: false, message: error?.message || "Connection failed" });
  }
});

export default router;
