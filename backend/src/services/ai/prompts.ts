/**
 * Prompts for AI-powered media recommendations.
 * 
 * Stored separately from service logic so they can be easily
 * modified, reviewed, and tested independently.
 */

export const RECOMMENDATIONS_SYSTEM_PROMPT = `You are an expert movie and TV show recommendation engine. Given a user's media library and watch history, suggest other movies and TV shows they would enjoy.

Rules:
- Recommend titles that are NOT already in the user's library.
- Include a mix of well-known and hidden gem recommendations.
- Consider genres, themes, directors, actors, and storytelling styles when making recommendations.
- Pay special attention to items the user has watched, rewatched multiple times, or marked as favorites — these indicate strong preferences.
- Items the user has NOT watched yet should be weighted less heavily than watched content when determining taste.
- Include both movies and TV shows in your recommendations.
- Each recommendation MUST include the full, exact title of the movie or TV show.
- Each recommendation MUST include the correct release year so it can be uniquely identified.
- In the reason field, always refer to the recommended title by name — never say "this film" or "this show".
- Keep reasons concise (1-2 sentences) and specific to why the user would enjoy it based on their library and watch preferences.
- Do not recommend sequels or entries from franchises already in the library unless they are standalone.
- Only recommend real, existing movies and TV shows. Do not invent titles.`;

// Maximum library items to include in the prompt to keep it focused
const MAX_LIBRARY_ITEMS = 40;

/**
 * Fisher-Yates shuffle (in-place).
 */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Builds the user prompt from the library contents.
 * Shuffles and caps library items to avoid LLM overfitting to order or volume.
 */
export function buildRecommendationsUserPrompt(
  library: Array<{ title: string; year?: number; type: "movie" | "tv" }>,
  watchHistory: Array<{
    name: string;
    type: 'Movie' | 'Series' | 'Episode';
    played: boolean;
    playCount: number;
    isFavorite: boolean;
  }> = []
): string {
  const movies = shuffle(library.filter((item) => item.type === "movie"));
  const tvShows = shuffle(library.filter((item) => item.type === "tv"));

  // Build a lookup of watch data by title (lowercase)
  const watchLookup = new Map<string, { played: boolean; playCount: number; isFavorite: boolean }>();
  for (const w of watchHistory) {
    if (w.type === 'Movie' || w.type === 'Series') {
      watchLookup.set(w.name.toLowerCase(), {
        played: w.played,
        playCount: w.playCount,
        isFavorite: w.isFavorite,
      });
    }
  }

  // Balance the selection: split the cap proportionally
  const totalAvailable = movies.length + tvShows.length;
  const cap = Math.min(totalAvailable, MAX_LIBRARY_ITEMS);
  const movieCap = totalAvailable > 0
    ? Math.round(cap * (movies.length / totalAvailable))
    : 0;
  const tvCap = cap - movieCap;

  const selectedMovies = movies.slice(0, Math.max(movieCap, 1));
  const selectedTv = tvShows.slice(0, Math.max(tvCap, 1));

  function formatItem(item: { title: string; year?: number }): string {
    let line = `- ${item.title}${item.year ? ` (${item.year})` : ""}`;
    const watch = watchLookup.get(item.title.toLowerCase());
    const tags: string[] = [];
    if (watch?.isFavorite) tags.push('favorite');
    if (watch?.played) {
      if (watch.playCount > 1) {
        tags.push(`watched ${watch.playCount} times`);
      } else {
        tags.push('watched');
      }
    } else {
      tags.push('not yet watched');
    }
    if (tags.length > 0) line += ` [${tags.join(', ')}]`;
    return line;
  }

  const movieList = selectedMovies.map(formatItem).join("\n");
  const tvList = selectedTv.map(formatItem).join("\n");

  let prompt = "Here is a sample of the user's current media library with watch status:\n\n";

  if (movieList && movies.length > 0) {
    prompt += `Movies:\n${movieList}\n\n`;
  }

  if (tvList && tvShows.length > 0) {
    prompt += `TV Shows:\n${tvList}\n\n`;
  }

  if (movies.length === 0 && tvShows.length === 0) {
    prompt += "(The library is empty)\n\n";
  }

  prompt += "Based on this library and the user's watch preferences, recommend 10-15 movies and TV shows the user would enjoy. Prioritize recommendations similar to items the user has actually watched and especially favorites. Do not recommend anything already in their library.";

  return prompt;
}
