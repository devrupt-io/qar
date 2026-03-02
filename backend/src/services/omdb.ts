import axios from 'axios';
import { config } from '../config';

export interface OmdbSearchResult {
  Title: string;
  Year: string;
  imdbID: string;
  Type: string;
  Poster: string;
}

export interface OmdbDetails {
  Title: string;
  Year: string;
  Rated: string;
  Released: string;
  Runtime: string;
  Genre: string;
  Director: string;
  Writer: string;
  Actors: string;
  Plot: string;
  Language: string;
  Country: string;
  Awards: string;
  Poster: string;
  Ratings: { Source: string; Value: string }[];
  Metascore: string;
  imdbRating: string;
  imdbVotes: string;
  imdbID: string;
  Type: string;
  totalSeasons?: string;
  Response: string;
}

export class OmdbService {
  private apiKey: string;
  private baseUrl = 'https://www.omdbapi.com';

  constructor() {
    this.apiKey = config.omdbApiKey;
  }

  /**
   * Set the API key dynamically (used when settings are updated)
   */
  setApiKey(key: string): void {
    this.apiKey = key;
    console.log(`OMDB API key ${key ? 'updated' : 'cleared'}`);
  }

  /**
   * Get the current API key (for status checks)
   */
  getApiKey(): string {
    return this.apiKey;
  }

  /**
   * Check if the API key is configured
   */
  isConfigured(): boolean {
    return !!this.apiKey && this.apiKey.length > 0;
  }

  /**
   * Initialize the service with API key from database if available
   */
  async initializeFromDatabase(): Promise<void> {
    try {
      // Dynamically import to avoid circular dependency
      const { Setting } = await import('../models');
      const dbSetting = await Setting.findOne({ where: { key: 'omdbApiKey' } });
      if (dbSetting && dbSetting.value) {
        this.apiKey = dbSetting.value;
        console.log('OMDB API key loaded from database');
      } else if (this.apiKey) {
        console.log('OMDB API key loaded from environment');
      } else {
        console.warn('OMDB API key not configured');
      }
    } catch (error) {
      // Database may not be ready yet, that's okay
      console.log('Could not load OMDB API key from database, using environment');
    }
  }

  async search(query: string, type?: 'movie' | 'series'): Promise<OmdbSearchResult[]> {
    if (!this.apiKey) {
      console.warn('OMDB API key not configured');
      return [];
    }

    try {
      const params: Record<string, string> = {
        apikey: this.apiKey,
        s: query,
      };

      if (type) {
        params.type = type;
      }

      const response = await axios.get(this.baseUrl, { params });

      if (response.data.Response === 'False') {
        return [];
      }

      return (response.data.Search || []).filter(
        (item: OmdbSearchResult) => item.Type === 'movie' || item.Type === 'series'
      );
    } catch (error) {
      console.error('OMDB search error:', error);
      return [];
    }
  }

  async getDetails(imdbId: string): Promise<OmdbDetails | null> {
    if (!this.apiKey) {
      console.warn('OMDB API key not configured');
      return null;
    }

    try {
      const response = await axios.get(this.baseUrl, {
        params: {
          apikey: this.apiKey,
          i: imdbId,
          plot: 'full',
        },
      });

      if (response.data.Response === 'False') {
        return null;
      }

      return response.data;
    } catch (error) {
      console.error('OMDB details error:', error);
      return null;
    }
  }

  async getSeasonDetails(imdbId: string, season: number): Promise<any> {
    if (!this.apiKey) {
      return null;
    }

    try {
      const response = await axios.get(this.baseUrl, {
        params: {
          apikey: this.apiKey,
          i: imdbId,
          Season: season,
        },
      });

      if (response.data.Response === 'False') {
        return null;
      }

      return response.data;
    } catch (error) {
      console.error('OMDB season details error:', error);
      return null;
    }
  }
}

export const omdbService = new OmdbService();
