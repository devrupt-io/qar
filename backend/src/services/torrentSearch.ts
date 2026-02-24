import axios, { AxiosInstance, AxiosError } from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { config } from '../config';
import { parseQuality, QualityInfo, calculateQualityScore, shouldAvoidTorrent } from './torrentQuality';

export interface TorrentResult {
  name: string;
  /** Magnet URI - may be null if not yet fetched (deferred loading) */
  magnetUri: string | null;
  seeders: number;
  leechers: number;
  size: string;
  uploadDate: string;
  uploader: string;
  /** URL to fetch magnet link from (used for deferred loading) */
  detailsUrl: string;
  /** Parsed quality metadata from torrent name */
  quality?: QualityInfo;
  /** Quality score based on user preferences (populated during ranking) */
  qualityScore?: number;
}

export interface SearchResponse {
  results: TorrentResult[];
  /** The actual search query that was used */
  searchQuery: string;
  /** Warning messages (e.g., partial failures) */
  warnings?: string[];
  /** Error message if search completely failed */
  error?: string;
  /** Which source was used for results */
  source?: string;
  /** Whether Tor is healthy */
  torHealthy?: boolean;
}

interface SearchResult {
  name: string;
  detailsUrl: string;
  seeders: number;
  leechers: number;
  size: string;
  uploadDate: string;
  uploader: string;
}

export class TorrentSearchService {
  private torAgent: SocksProxyAgent;
  private torClient: AxiosInstance;
  private clearnetClient: AxiosInstance;
  private currentBaseUrl: string | null = null;

  constructor() {
    // Create SOCKS5 proxy agent for Tor
    const torProxyUrl = `socks5h://${config.tor.host}:${config.tor.port}`;
    console.log(`[TorrentSearch] Initializing Tor proxy: ${torProxyUrl}`);
    this.torAgent = new SocksProxyAgent(torProxyUrl);
    
    // Tor client for .onion sites
    this.torClient = axios.create({
      httpAgent: this.torAgent,
      httpsAgent: this.torAgent,
      timeout: 45000, // Longer timeout for Tor
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    
    // Clearnet client for regular HTTP/HTTPS
    this.clearnetClient = axios.create({
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
  }

  private getClient(url: string): AxiosInstance {
    return url.includes('.onion') ? this.torClient : this.clearnetClient;
  }

  /**
   * Check if Tor is healthy by testing connection
   */
  async checkTorHealth(): Promise<{ healthy: boolean; error?: string }> {
    try {
      const testUrl = config.leet.onionUrl;
      const response = await this.torClient.get(testUrl, { timeout: 15000 });
      return { healthy: response.status === 200 };
    } catch (error) {
      const err = error as Error;
      let errorMsg = err.message;
      if (errorMsg.includes('SOCKS') || errorMsg.includes('proxy')) {
        errorMsg = 'Tor SOCKS5 proxy not responding. Tor service may need restart.';
      }
      return { healthy: false, error: errorMsg };
    }
  }

  /**
   * Reinitialize the Tor proxy agent (useful after Tor restart)
   */
  reinitializeTorAgent(): void {
    const torProxyUrl = `socks5h://${config.tor.host}:${config.tor.port}`;
    console.log(`[TorrentSearch] Reinitializing Tor proxy: ${torProxyUrl}`);
    this.torAgent = new SocksProxyAgent(torProxyUrl);
    
    this.torClient = axios.create({
      httpAgent: this.torAgent,
      httpsAgent: this.torAgent,
      timeout: 45000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
  }

  /**
   * Search for torrents - returns results WITHOUT magnet URIs for speed.
   * Call getMagnetUri() to fetch the magnet when user selects a torrent.
   */
  async search(query: string, category?: 'Movies' | 'TV'): Promise<SearchResponse> {
    const startTime = Date.now();
    console.log(`[TorrentSearch] Starting search for: "${query}" (category: ${category || 'all'})`);
    
    // Build list of URLs to try (Tor first, then clearnet fallbacks)
    const urlsToTry = [
      config.leet.onionUrl,
      ...config.leet.clearnetUrls,
    ];

    const warnings: string[] = [];
    let lastError: Error | null = null;
    let torHealthy = true;

    for (const baseUrl of urlsToTry) {
      try {
        console.log(`[TorrentSearch] Trying source: ${baseUrl}`);
        const results = await this.searchFromSource(baseUrl, query, category);
        
        if (results.length > 0) {
          this.currentBaseUrl = baseUrl;
          const elapsed = Date.now() - startTime;
          console.log(`[TorrentSearch] Search completed in ${elapsed}ms from ${baseUrl}`);
          
          // Add warning if we had to fall back from Tor
          if (baseUrl !== config.leet.onionUrl && urlsToTry[0] === config.leet.onionUrl) {
            warnings.push('Tor was unavailable, used fallback source');
            torHealthy = false;
          }
          
          return {
            results,
            searchQuery: query,
            warnings: warnings.length > 0 ? warnings : undefined,
            source: baseUrl.includes('.onion') ? 'tor' : 'clearnet',
            torHealthy,
          };
        }
        
        console.log(`[TorrentSearch] No results from ${baseUrl}, trying next...`);
      } catch (error) {
        lastError = error as Error;
        const elapsed = Date.now() - startTime;
        const errorMsg = (error as Error).message;
        console.log(`[TorrentSearch] Source ${baseUrl} failed after ${elapsed}ms: ${errorMsg}`);
        
        // Track Tor-specific failures
        if (baseUrl.includes('.onion')) {
          torHealthy = false;
          if (errorMsg.includes('SOCKS') || errorMsg.includes('proxy')) {
            warnings.push('Tor SOCKS5 proxy error - Tor service may need restart');
          } else if (errorMsg.includes('timeout')) {
            warnings.push('Tor connection timed out');
          } else {
            warnings.push(`Tor error: ${errorMsg.substring(0, 100)}`);
          }
        }
      }
    }

    // All sources failed — provide a user-friendly error
    let errorMessage: string;
    if (lastError) {
      const msg = lastError.message;
      if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo') || msg.includes('ECONNREFUSED')) {
        errorMessage = 'Search sources are currently unreachable. Ensure Tor/VPN is running.';
      } else if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
        errorMessage = 'Search timed out. Try again or check your network connection.';
      } else if (msg.includes('403') || msg.includes('Cloudflare')) {
        errorMessage = 'Search sources are blocked. Ensure Tor is running for best results.';
      } else {
        errorMessage = 'Search failed. Check that the VPN and Tor services are running.';
      }
    } else {
      errorMessage = 'No results found from any source';
    }
    
    console.error('[TorrentSearch] All sources failed. Last error:', lastError?.message);
    
    return {
      results: [],
      searchQuery: query,
      error: errorMessage,
      warnings: warnings.length > 0 ? warnings : undefined,
      torHealthy,
    };
  }

  private async searchFromSource(baseUrl: string, query: string, category?: 'Movies' | 'TV'): Promise<TorrentResult[]> {
    const startTime = Date.now();
    const client = this.getClient(baseUrl);
    
    // 1337x uses /search/query/page/ format
    const searchPath = category 
      ? `/category-search/${encodeURIComponent(query)}/${category === 'Movies' ? 'Movies' : 'TV'}/1/`
      : `/search/${encodeURIComponent(query)}/1/`;
    
    const searchUrl = `${baseUrl}${searchPath}`;
    console.log(`[TorrentSearch] Request URL: ${searchUrl}`);
    
    const response = await client.get(searchUrl);
    const elapsed = Date.now() - startTime;
    console.log(`[TorrentSearch] Response received in ${elapsed}ms (status: ${response.status}, size: ${response.data?.length || 0} bytes)`);
    
    // Parse search results (these don't have magnet links yet)
    const searchResults = this.parseSearchResults(response.data, baseUrl);
    console.log(`[TorrentSearch] Found ${searchResults.length} search results`);
    
    if (searchResults.length === 0) {
      return [];
    }
    
    // Return top 15 results WITHOUT fetching magnet links (deferred loading)
    // Magnet links are fetched on-demand when user selects a torrent
    const topResults = searchResults.slice(0, 15);
    
    const results: TorrentResult[] = topResults.map(result => {
      // Parse quality information from torrent name
      const quality = parseQuality(result.name);
      return {
        ...result,
        magnetUri: null, // Deferred - fetch when user selects
        quality,
      };
    });
    
    console.log(`[TorrentSearch] Returning ${results.length} results (magnet links deferred)`);
    
    if (results.length > 0) {
      console.log(`[TorrentSearch] Top results:`);
      results.slice(0, 3).forEach((r, i) => {
        console.log(`  ${i + 1}. "${r.name}" (${r.seeders} seeders, ${r.size})`);
      });
    }
    
    return results;
  }

  private parseSearchResults(html: string, baseUrl: string): SearchResult[] {
    const results: SearchResult[] = [];
    
    // Check if we got a valid response
    if (!html || html.length < 100) {
      console.warn('[TorrentSearch] HTML response is too short, likely an error page');
      return results;
    }
    
    // Check for "no results" message
    if (html.includes('No results were returned') || html.includes('Nothing found!')) {
      console.log('[TorrentSearch] Search returned no results');
      return results;
    }
    
    // Find the search results table body
    const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    if (!tbodyMatch) {
      console.log('[TorrentSearch] No table body found in response');
      // Log first 500 chars for debugging
      console.log('[TorrentSearch] HTML preview:', html.substring(0, 500));
      return results;
    }
    
    const tbody = tbodyMatch[1];
    
    // Parse individual rows
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let match;
    
    while ((match = rowRegex.exec(tbody)) !== null) {
      const row = match[1];
      
      try {
        // Extract torrent name and details URL
        // Format: <a href="/torrent/123456/Torrent-Name/">Torrent Name</a>
        const linkMatch = row.match(/href="(\/torrent\/\d+\/[^"]+\/)">([^<]+)<\/a>/);
        if (!linkMatch) continue;
        
        const detailsPath = linkMatch[1];
        const name = this.decodeHtmlEntities(linkMatch[2].trim());
        const detailsUrl = `${baseUrl}${detailsPath}`;
        
        // Extract seeders
        const seedersMatch = row.match(/class="seeds[^"]*">(\d+)<\/td>/i) || 
                            row.match(/class="coll-2[^"]*">(\d+)<\/td>/i);
        const seeders = seedersMatch ? parseInt(seedersMatch[1], 10) : 0;
        
        // Extract leechers
        const leechersMatch = row.match(/class="leeches[^"]*">(\d+)<\/td>/i) || 
                             row.match(/class="coll-3[^"]*">(\d+)<\/td>/i);
        const leechers = leechersMatch ? parseInt(leechersMatch[1], 10) : 0;
        
        // Extract size - look for pattern like "1.4 GB" in size column
        const sizeMatch = row.match(/class="size[^"]*"[^>]*>([^<]+)</i) ||
                         row.match(/class="coll-4[^"]*"[^>]*>([^<]+)</i);
        const size = sizeMatch ? sizeMatch[1].trim() : 'Unknown';
        
        // Extract date
        const dateMatch = row.match(/class="coll-date[^"]*">([^<]+)<\/td>/i);
        const uploadDate = dateMatch ? dateMatch[1].trim() : 'Unknown';
        
        // Extract uploader
        const uploaderMatch = row.match(/class="(?:vip|user)[^"]*">([^<]+)<\/a>/i);
        const uploader = uploaderMatch ? uploaderMatch[1].trim() : 'Anonymous';
        
        results.push({
          name,
          detailsUrl,
          seeders,
          leechers,
          size,
          uploadDate,
          uploader,
        });
      } catch (e) {
        // Skip malformed rows
        console.log('[TorrentSearch] Failed to parse row:', (e as Error).message);
      }
    }
    
    console.log(`[TorrentSearch] Parsed ${results.length} search results from HTML`);
    return results;
  }

  /**
   * Fetch the magnet URI from a torrent details page.
   * This is called on-demand when user selects a torrent to download.
   */
  async getMagnetUri(detailsUrl: string): Promise<{ magnetUri: string | null; error?: string }> {
    console.log(`[TorrentSearch] Fetching magnet URI from: ${detailsUrl}`);
    const startTime = Date.now();
    const client = this.getClient(detailsUrl);
    
    try {
      const response = await client.get(detailsUrl);
      const elapsed = Date.now() - startTime;
      
      // Look for magnet link
      const magnetMatch = response.data.match(/href="(magnet:\?xt=urn:btih:[^"]+)"/i);
      
      if (magnetMatch) {
        console.log(`[TorrentSearch] Magnet URI fetched in ${elapsed}ms`);
        return { magnetUri: magnetMatch[1] };
      }
      
      console.log(`[TorrentSearch] No magnet link found on page after ${elapsed}ms`);
      return { magnetUri: null, error: 'No magnet link found on page' };
    } catch (error) {
      const elapsed = Date.now() - startTime;
      const errorMsg = (error as Error).message;
      console.error(`[TorrentSearch] Error fetching magnet after ${elapsed}ms:`, errorMsg);
      
      let userError = 'Failed to fetch magnet link';
      if (errorMsg.includes('SOCKS') || errorMsg.includes('proxy')) {
        userError = 'Tor connection error - try again or restart Tor';
      } else if (errorMsg.includes('timeout')) {
        userError = 'Request timed out - Tor may be slow';
      }
      
      return { magnetUri: null, error: userError };
    }
  }

  private async getMagnetFromDetails(url: string): Promise<string | null> {
    const result = await this.getMagnetUri(url);
    return result.magnetUri;
  }

  private decodeHtmlEntities(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }

  async getTorrentDetails(url: string): Promise<{ magnetUri: string } | null> {
    console.log(`[TorrentSearch] Fetching torrent details: ${url}`);
    const result = await this.getMagnetUri(url);
    if (result.magnetUri) {
      return { magnetUri: result.magnetUri };
    }
    return null;
  }
}

export const torrentSearchService = new TorrentSearchService();
