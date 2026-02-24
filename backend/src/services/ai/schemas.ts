/**
 * Structured output schema for AI recommendations.
 * 
 * Used with OpenRouter's structured output (response_format) to get
 * consistent, parseable responses from the LLM.
 */

export const recommendationsSchema = {
  type: "json_schema" as const,
  json_schema: {
    name: "media_recommendations",
    strict: true,
    schema: {
      type: "object",
      properties: {
        recommendations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "The title of the recommended movie or TV show. Use the official English title.",
              },
              year: {
                type: "number",
                description: "The release year of the recommended movie or TV show.",
              },
              type: {
                type: "string",
                enum: ["movie", "tv"],
                description: "Whether this is a movie or a TV show.",
              },
              reason: {
                type: "string",
                description: "A brief explanation of why this is recommended based on the user's library. Keep it to 1-2 sentences.",
              },
            },
            required: ["title", "year", "type", "reason"],
            additionalProperties: false,
          },
          description: "A list of 10-15 recommended movies and TV shows the user might enjoy.",
        },
      },
      required: ["recommendations"],
      additionalProperties: false,
    },
  },
};

export interface Recommendation {
  title: string;
  year: number;
  type: "movie" | "tv";
  reason: string;
}

export interface RecommendationsResponse {
  recommendations: Recommendation[];
}
