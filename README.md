# Qar

Qar is a simple to use all-in-one self-hosted media system.

Under the hood:

- Linux: The underlying operating system that provides networking, disks,
  docker, etc.
- Jellyfin: Provides a media server that arranges Movies, TV, and Web content
  into a UI similar to streaming services.
- QBittorrent: A BitTorrent client that uses a VPN.
- Frontend: A Next.js frontend that allows users to easily add TV and movies to
  their collection. 
- Backend: An Express TypeScript backend that uses Sequelize and PostgreSQL to
  store data, orchestrate downloads, and serves media files.

## System design

Qar is installed on a Linux system that is already running Docker. Most of it
runs within a docker stack, except for a small host helper script.

### Storage Configuration

Qar supports two types of storage:

1. **External Disks**: The Linux system may have multiple different disks,
   which are available on the host system as `/qar/disks/x` and `/qar/disks/y`.
   Each disk is a different large hard drive (2TB) that has directories for
   `tv`, `movies`, and `web`.

2. **Default Storage**: A local `./storage` directory that serves as a fallback
   when no external disks are configured. This is useful for testing or small
   installations. The default storage is automatically used if no external disks
   are found in `/qar/disks`.

3. **Downloads Volume**: A shared Docker volume (`qbittorrent_downloads`) is
   used for active downloads. QBittorrent saves to `/downloads` inside its
   container, which maps to the same volume that the backend accesses at
   `/qar/downloads`. This shared volume allows the backend to access
   downloaded files for processing and moving to storage.

For TV shows the structure is `tv/<name>/Season <n>/*.(mp4|mkv)`.

For Movies the structure is `movies/<name> (<year>)/*.(mp4|mkv)`.

For Web the structure is `web/<channel>/*.(mp4|mkv)`.

There must be a script on the host system that ensures that disks are mounted
correctly, docker volumes are running, etc.

The Jellyfin content is stored in a single directory `/qar/content` which stores
the same `tv`, `movies`, and `web` directories, except these store `.strm` files
that contact the backend server, which handles download and streaming of
content. These are designed to be easy to backup or share.

### Content Recovery and Scanning

Qar includes an automated content scanner that recovers media from existing
files on disk. This is useful when:

- Migrating to a new server without database backup
- Recovering from database loss
- Importing media from another system

**How it works:**

1. **Content Directory Scan**: Finds `.strm` and `.yml` files in `content/`
2. **Storage Directory Scan**: Finds video files (`.mp4`, `.mkv`) in `storage/`
3. **OMDB Lookup**: Retrieves metadata (poster, plot, IMDB ID) from OMDB API
4. **Database Import**: Creates MediaItem and TVShow records
5. **File Linking**: Links storage files to content files

**Rate Limiting**: To avoid hammering the OMDB API, scanning is rate-limited
to 100 items per hour by default. This can be configured via the API.

**YAML Metadata**: The `.yml` files store extended metadata that aids recovery:

```yaml
title: The Matrix
year: 1999
imdbId: tt0133093
magnetUri: null
season: null
episode: null
addedAt: 2026-01-03T07:28:51.546Z
posterUrl: https://example.com/poster.jpg
plot: A computer hacker learns about the true nature of reality...
scannedAt: 2026-01-05T10:00:00.000Z
recoveredFrom: content
```

**API Endpoints:**
- `GET /api/scanner/status` - Get scanner status and progress
- `POST /api/scanner/scan` - Trigger a manual scan
- `POST /api/scanner/settings` - Update rate limit settings
- `GET /api/scanner/preview` - Preview what would be scanned without processing
- `POST /api/scanner/fix-images` - Fix items missing poster images

The scanner runs automatically at startup and every hour thereafter.

### Progress Videos and Direct Paths

The `.strm` files follow a two-phase approach for optimal Jellyfin playback:

#### Phase 1: Progress Video (During Download)

When media is first added to the library, `.strm` files point to progress video
endpoints on the backend server. When a user tries to play content that hasn't
been downloaded yet, they see a **live video showing download progress** instead
of an error or buffering state.

The progress video displays:
- Media title
- Download status (pending, downloading, paused, failed)
- Progress bar with percentage
- Download speed and estimated time remaining
- Qar branding and user instructions

**Continuous Streaming**: The progress video uses a unique continuous streaming
approach:
- Video is generated as 15-second segments that play back-to-back
- Each segment shows the current download progress at generation time
- When the download completes, the stream ends gracefully
- This prevents Jellyfin from marking the content as "watched" prematurely
- Users can watch the progress video for the entire duration of the download

**Technical Implementation**:
- FFmpeg generates each segment with a static progress overlay
- Segments are streamed directly to the client without disk caching
- The stream automatically terminates when the download finishes
- Minimal CPU usage (1fps, static image encoding at 1280x720)

Progress video URLs follow a consistent, human-readable format:

- **Movies**: `http://backend:3001/progress/movies/{title-slug}/{year}`
  - Example: `http://backend:3001/progress/movies/the+matrix/1999`
- **TV Shows**: `http://backend:3001/progress/tv/{title-slug}/s{season}e{episode}`
  - Example: `http://backend:3001/progress/tv/stranger+things/s01e01`
- **Web**: `http://backend:3001/progress/web/{title-slug}`

The slug is created by converting the title to lowercase and replacing
non-alphanumeric characters with `+`.

The progress video is generated using FFmpeg with a dark themed background
at 1280x720 resolution and minimal CPU usage (1fps, static image encoding).

#### Phase 2: Direct Paths (After Download Completion)

Once a download completes and the file is moved to storage, the `.strm` file is
automatically updated to contain a direct path to the video file:

- Example: `/storage/movies/The Matrix (1999)/The Matrix (1999).mkv`

This path points to Jellyfin's `/storage` mount, which maps to `./storage` on
the host. This is where actual video files are stored after download.

Direct paths allow Jellyfin to:
- Analyze the file format and codecs
- Enable direct play without transcoding
- Provide faster seeking and better playback performance

After the `.strm` file is updated, the backend automatically triggers a Jellyfin
library refresh for that specific item so the change takes effect immediately.

#### Storage Architecture

- `./content` → Jellyfin `/media` (read-only): Contains `.strm` and `.yml` metadata files
- `./storage` → Jellyfin `/storage` (read-only): Contains actual video files after download

This separation allows `.strm` files to be lightweight and easily shared, while
video files are stored separately in the storage directory.

#### Why Not Stream the Actual Video?

Previous versions used `/stream/*` endpoints that would stream the actual video
file during download. This approach was deprecated for Jellyfin because:

1. **Transcoding Issues**: Jellyfin cannot determine media properties when
   streaming through HTTP, causing it to transcode even when direct play would
   work. This wastes CPU resources.
2. **Poor UX**: Users would see buffering or errors when content wasn't ready.
3. **Complex Logic**: The streaming endpoint had to handle downloads in progress,
   file searching, and fallback logic.

The progress video approach provides clear feedback to users and ensures optimal
direct play once the download completes.

#### Stream URLs for External Players

The `/stream/*` endpoints are available for external media players like VLC.
Users can copy the stream URL from the media details page and use it in any
player that supports HTTP streaming.

Stream URL formats:
- **Movies**: `http://localhost:3001/stream/movies/{title-slug}/{year}`
- **TV Shows**: `http://localhost:3001/stream/tv/{title-slug}/s{season}e{episode}`
- **Web**: `http://localhost:3001/stream/web/{title-slug}`

**Behavior**: When the media file is available on disk, the stream endpoint
serves the actual video file with support for seeking (range requests). When
the file is not yet downloaded, it redirects to the progress video endpoint.

#### Migrating Existing Stream URLs

If you have existing `.strm` files that still use stream or progress URLs (from
before the download completed), you can migrate them to direct paths:

```bash
curl -X POST http://localhost:3001/api/media/migrate-strm-files
```

This will:
1. Find all `.strm` files that contain `/stream/` or `/progress/` URLs
2. Check if the corresponding video file exists on disk
3. Update each `.strm` file to use the direct path
4. Trigger a Jellyfin refresh for each updated item

**Note**: Only items that have completed downloads (with files on disk) will be
migrated. Items still downloading will continue to use progress video URLs.

Next to each `.strm` file there may also be a YAML file that stores metadata
about what Magnet links to use for download. The goal is that a large library of
these `.strm` and `.yml` files can be stored and shared.

## Docker Services

The system must use a `docker-compose.yml` file.

The docker services need to expose Jellyfin on the default port.

The QBittorrent service must use a VPN, something like:

```yaml
services:
    pia-qbittorrent:
        image: j4ym0/pia-qbittorrent
        container_name: pia-qbittorrent
        cap_add:
            - NET_ADMIN
        env_file:
            - ./config/.env  # Contains USER, PASSWORD, REGION
        environment:
            - REGION=${PIA_REGION:-Netherlands}
            - ALLOW_LOCAL_SUBNET_TRAFFIC=true
            - HOSTHEADERVALIDATION=false
            - CSRFPROTECTION=false
        volumes:
            - qbittorrent_config:/config
            - qbittorrent_downloads:/downloads  # Shared with backend
            - ./config/post-vpn-connect.sh:/config/post-vpn-connect.sh:ro
        ports:
            - "8888:8888"
        restart: unless-stopped
```

The `./config/.env` file is managed by the backend and contains:
- `USER`: PIA VPN username
- `PASSWORD`: PIA VPN password  
- `REGION`: VPN region (e.g., Netherlands)

However, the user must be able to configure their VPN username and password
within the web interface.

### Docker Network Routing Fix

The j4ym0/pia-qbittorrent container uses policy-based routing to ensure all
traffic goes through the VPN. This creates a routing table (table 128) that
doesn't include a direct route for the Docker network subnet, causing
container-to-container communication to fail.

The `config/post-vpn-connect.sh` hook script fixes this by adding the Docker
subnet route to table 128 after the VPN connects.

### QBittorrent Authentication

The j4ym0/pia-qbittorrent container generates a new random WebUI password each
time it starts, which makes traditional username/password authentication
problematic for the backend service.

**Solution**: The `config/post-vpn-connect.sh` hook script configures
QBittorrent's WebUI to bypass authentication for Docker network subnets. This
allows the backend to communicate with QBittorrent without needing to know the
WebUI password.

The hook script sets the following in `/config/qBittorrent/config/qBittorrent.conf`:

```ini
[Preferences]
WebUI\AuthSubnetWhitelistEnabled=true
WebUI\AuthSubnetWhitelist=172.16.0.0/12, 10.0.0.0/8, 192.168.0.0/16
```

This configuration whitelists all common Docker network ranges:
- `172.16.0.0/12` - Docker's default bridge networks
- `10.0.0.0/8` - Alternative private network range
- `192.168.0.0/16` - Host network and some custom configurations

The backend automatically detects when authentication bypass is available and
uses it instead of attempting password-based login. This prevents IP bans that
could occur from repeated failed login attempts.

### VPN Configuration Flow

The VPN configuration process works as follows:

1. **User enters credentials**: The user enters their PIA VPN username and
   password in the Settings page of the Qar web interface.

2. **Credentials are saved**: When the user clicks "Save Settings", the
   credentials are stored in the PostgreSQL database and also synced to the
   `./config/.env` file.

3. **Container restart required**: The QBittorrent container reads VPN
   credentials from environment variables at startup. After saving new
   credentials, the container must be restarted to pick up the changes:
   ```bash
   docker compose up -d pia-qbittorrent
   ```

4. **Status verification**: The Settings page shows the current VPN status:
   - **Not Configured**: No VPN credentials have been entered
   - **Starting...**: Credentials are configured but QBittorrent is not yet
     responding (container may be starting or connecting to VPN)
   - **Connected**: QBittorrent is available and working

The system differentiates between "credentials not configured" and "credentials
configured but service not available" to provide helpful guidance to users.

## Backend design

The backend must be written in TypeScript, Express, and Sequelize for talking to
the PostgreSQL database.

The backend must have Tor installed because some services must be accessed via
Tor, such as 1337x.

The backend server must automate searching for Movies and TV via the OMDb API.
This information is reported back to the frontend so the user can select which
movie or TV show they are looking for, seasons, etc.

### Torrent Search

The torrent search functionality connects to 1337x to find download sources:

1. **Primary Source**: The Tor hidden service (.onion) is used for privacy
2. **Fallback Sources**: If Tor is unavailable or slow, clearnet mirrors are used
3. **Detailed Logging**: All search attempts are logged with timing information

The search process:
1. Queries the torrent search engine
2. Parses the search results HTML to extract torrent names, sizes, and seeders
3. Fetches the detail page for each result to extract the magnet link
4. **Parses quality metadata** from the torrent name (resolution, codec, source, group)
5. Returns the top 10 results with magnet URIs and quality information

### Quality Preferences

Qar includes intelligent torrent selection based on quality metadata parsed from
torrent names. This ensures the best quality content is downloaded automatically.

**Quality Parsing**: Each torrent name is analyzed to extract:
- **Resolution**: 2160p (4K), 1080p, 720p, 480p, etc.
- **Codec**: x265/HEVC, x264, AV1, VP9, etc.
- **Source**: BluRay, WEB-DL, WEBRip, HDTV, DVDRip, etc.
- **Release Group**: Known quality groups like SPARKS, RARBG, YTS, etc.
- **HDR**: Dolby Vision, HDR10+, HDR, etc.

**Quality Scoring**: When auto-downloading, torrents are scored based on:
1. **Resolution** (highest priority): 4K > 1080p > 720p > lower
2. **Source quality**: BluRay > WEB-DL > WEBRip > HDTV > DVDRip
3. **Codec efficiency**: x265 > x264 (same quality, smaller files)
4. **Release group reputation**: Trusted groups score higher
5. **Seeder count**: More seeders = faster, more reliable downloads

**Avoided Content**: Certain torrents are automatically filtered out:
- CAM, TS, HDCAM, and other theater recordings
- SCREENER versions
- Torrents with very low seeder counts

**Best Torrent Selection**: The auto-download system automatically selects the
highest-scoring torrent for each media item, prioritizing quality while avoiding
low-quality sources.

Debugging: If torrent search fails, check the backend logs for messages like:
- `[TorrentSearch] Trying source: ...` - Shows which source is being attempted
- `[TorrentSearch] Response received in Xms` - Confirms successful connection
- `[TorrentSearch] Found X search results` - Shows parsing success

### Adding Media

When a user selects a **movie** to add, a `.strm` file is created with the
appropriate stream URL.

When a user selects a **TV show** to add, the backend:
1. Creates a `TVShow` entry in the database to track the show itself
2. Fetches all seasons and episodes from OMDB
3. Creates `.strm` files for every episode

This allows the entire show to appear in Jellyfin immediately. Episodes are
downloaded on-demand when the user actually plays them, saving disk space.

When downloading TV episodes, a torrent may contain multiple episodes. The
download record tracks which episodes are included via the `episodeIds` field,
allowing the system to properly update all related episodes when the download
completes.

Downloads are handled via 1337x torrent search using the Tor hidden service URL.

When a request comes in to play a movie or TV show (via a URL that was in a
`.strm` file from Jellyfin) and the content hasn't been downloaded yet, the
backend serves a progress video showing the download status. Once downloaded,
the `.strm` file is updated to point directly to the file for optimal playback.

When downloading the information about the download must be saved in the
database and then the magnet URL must be passed to QBittorrent to download the
needed content only. When the download is finished it must be moved to one of
the media disks in the appropriate directory (or the default storage if no
external disks are configured). If the TV show is already present on a disk it
should be used to store more of that show.

### Download Manager

The backend includes an automated download manager that runs as a background
service:

1. **Periodic Sync**: Every 30 seconds, the download manager queries QBittorrent
   for the status of all active downloads and updates the database accordingly.

2. **Smart File Selection**: For TV show downloads, Qar intelligently selects
   only the files needed:
   - When adding a torrent, file priorities are configured based on wanted episodes
   - Only matching episode files are set to download; others are skipped
   - This prevents downloading entire season packs when only one episode is needed
   - File selection uses pattern matching (e.g., `S01E05` or `1x05` formats)
   - During sync, files are re-verified to ensure priorities are correctly set

3. **Incremental Episode Processing**: For large TV series downloads (like
   complete series torrents with hundreds of episodes), Qar processes episodes
   incrementally as they complete:
   - Each episode file is processed **immediately when it finishes**, not when
     the entire torrent completes
   - The completed file is copied to storage and the `.strm` file is updated
   - The file priority is set to 0 ("do not download") in QBittorrent
   - The original file is deleted from the downloads directory to free up space
   - This allows users to start watching episodes while the rest of the series
     is still downloading

4. **Episode Priority Boosting**: When a user tries to watch an episode that
   isn't downloaded yet:
   - The progress video endpoint automatically boosts that episode's priority
   - The specific file is set to maximum priority (7) in QBittorrent
   - The torrent is moved to the top of the download queue
   - First/last piece priority is enabled for faster initial playback
   - This ensures users get the content they want to watch first

   API endpoint for manual priority boosting:
   - `POST /api/downloads/boost-priority/:mediaItemId` - Boost priority for a
     specific episode

5. **Completion Handling**: When a download completes:
   - The downloaded file is identified and selected (largest video file)
   - The file is copied to the appropriate storage location (external disks or
     default storage)
   - The torrent is removed from QBittorrent (with files deleted since they've
     been copied)
   - The download record is updated with completion timestamp
   - The media item's `filePath` and `diskPath` are updated to reflect the
     file's location
   - **The `.strm` file is updated** to contain the direct path to the video
     file (e.g., `/media/movies/The Matrix (1999)/The Matrix.mkv`) instead of
     the progress video URL
   - **Jellyfin is notified** to refresh the media item so it recognizes the
     updated `.strm` file and can enable direct play

6. **Recovery Handling**: The download manager also handles edge cases:
   - If a download was marked complete but the file wasn't moved (e.g., due to
     a container restart), it will be re-processed on the next sync
   - Path mapping between QBittorrent's internal paths and the backend's
     accessible paths is handled automatically
   - Multi-file torrents are searched recursively to find the main video file

7. **Download History**: Completed downloads are retained in the database for
   history purposes, allowing users to see what has been downloaded and when.

### Media Status Display

The library view shows the status of each media item:

- **Available**: The file exists on disk and is ready to play
- **Downloaded**: The download completed (file may be processing)
- **Downloading X%**: Active download with progress percentage
- **Pending**: Download queued but not yet started
- **Paused**: Download is paused
- **Failed**: Download encountered an error
- **Not Downloaded**: No download has been started

The status is determined by checking both the `filePath`/`diskPath` fields (for
completed files) and the associated download records (for in-progress or
completed downloads).

### Pinning Media

Users can "pin" media items to mark them for offline storage:

- **Pinned items** are flagged in the database and can be prioritized for
  download
- **TV shows** can be pinned as a whole (all episodes) or individually
- Pinned status is visible in the library grid and details page
- API endpoints:
  - `POST /api/media/:id/pin` - Pin a single item
  - `POST /api/media/:id/unpin` - Unpin a single item
  - `POST /api/media/tv/show/:title/pin` - Pin all episodes of a TV show
  - `GET /api/media/pinned` - Get all pinned items

### Media Details Page

Each media item has a dedicated details page (`/media/:id`) that provides:

- **Full information**: Title, year, plot, poster, and type
- **Status indicator**: Shows if content is available, downloading, or needs
  download
- **Download progress**: Real-time progress bar with speed and ETA for active
  downloads
- **Primary action**: "Watch Now" button that links to Jellyfin when content is
  available, or "Download" button to find and start a download
- **Secondary actions**: Pin/unpin for offline storage, delete, IMDb link, and
  copy stream URL
- **Stream URL**: A copyable stream URL is displayed for use in external players
  like VLC (note: streaming through the backend may cause transcoding issues in
  Jellyfin, but works well for external players)
- **Related content**: For TV episodes, shows how many related episodes are in
  the library

## Frontend design

The frontend must be a Next.js web interface that speaks to the backend server.
The frontend does not speak directly to other services like QBittorrent or
Jellyfin.

### Error Handling

The frontend implements comprehensive error handling to prevent crashes:

- **Global Error Boundary**: Next.js error pages (`error.tsx` and
  `global-error.tsx`) catch unhandled errors and display user-friendly error
  messages with retry options
- **Page-level Error Boundaries**: Individual pages like media details wrap
  their content in error boundaries to prevent cascading failures
- **Graceful Degradation**: API errors are caught and displayed to users with
  helpful messages rather than crashing the application

The homepage must provide a text box that allows the user to quickly enter the
name of something they want and it will be passed to the backend server to
determine what TV shows or movies exist that could be added to the library.

### Library Grid

The library page displays media items in a responsive grid. Clicking any item
navigates to the media details page. The grid shows:

- Media poster (or type icon if no poster)
- Title with year/episode info
- Status badge (Available, Downloading %, Pending, etc.)
- Pinned indicator

**Note**: The grid uses a clean design without hover overlays or action icons.
All actions are available on the media details page.

The frontend must show basic disk statistics so the user knows if they need to
expand their storage.

The frontend must provide basic settings, such as the VPN username and password,
bandwidth limits, etc.

### Downloads Page

The downloads page is split into two sections:

1. **Active Downloads**: Shows currently downloading, pending, or paused
   downloads with real-time progress, speed, and ETA. Users can pause, resume,
   or cancel downloads.

2. **Download History**: A collapsible section showing completed downloads with
   completion timestamps. This helps users track what has been downloaded and
   when.

Active downloads that complete are automatically moved to history on the next
refresh (every 5 seconds).

### Jellyfin Integration

The frontend provides a "Watch" button in the navbar that redirects users to
Jellyfin. The backend automatically sets up Jellyfin on first run with:

- Default credentials (username: `qar`, password: `qar`)
- Media libraries pointing to `/media/movies`, `/media/tv`, and `/media/web`
- Automatic token-based authentication so users don't need to log in

#### Automatic Library Setup

Qar provides **fully automatic Jellyfin configuration** so users don't need to
manually add libraries. The backend runs a periodic background task that:

1. **Creates content directories**: Ensures `movies`, `tv`, and `web` directories
   exist in the content folder
2. **Completes the Jellyfin setup wizard**: If Jellyfin hasn't been configured,
   the backend automatically completes the setup wizard with default credentials
3. **Creates and updates media libraries**: Movies, TV, and Web libraries are
   automatically configured pointing to the correct content directories. If
   library names have changed (e.g., "TV Shows" → "TV"), they are renamed.
4. **Runs continuously**: The background task keeps retrying with exponential
   backoff (5s to 60s intervals) until Jellyfin is fully configured

This means a user can go from a blank installation to a fully working Jellyfin
server with no manual configuration. The setup handles:

- **Slow Jellyfin startup**: If Jellyfin takes time to start, the backend
  patiently waits and retries
- **Pre-configured instances**: If Jellyfin was previously set up, the backend
  ensures libraries exist and are properly configured
- **Clean error logging**: Network errors and API failures are logged concisely
  without verbose stack traces

Any media added through the Qar frontend will automatically appear in Jellyfin
since it watches the library directories with real-time monitoring enabled.

The redirect flow:
1. User clicks "Watch" button
2. Frontend redirects to `/jellyfin-redirect` page
3. Page calls `/api/jellyfin/status` to check if Jellyfin is ready
4. If not configured, page calls `/api/jellyfin/setup` to auto-configure
5. Page gets an access token via `/api/jellyfin/token`
6. Page redirects to `http://localhost:8096/web/qar-login.html` (served by Jellyfin)
7. The qar-login.html page sets Jellyfin credentials in localStorage and redirects to the Jellyfin home page

The qar-login.html file is mounted into the Jellyfin container at
`/jellyfin/jellyfin-web/qar-login.html` and served at `http://localhost:8096/web/qar-login.html`.
This ensures the credentials are set on the correct origin (localhost:8096).

## Architecture

### Service Ports

| Service | Port | Description |
|---------|------|-------------|
| Frontend | 3000 | Next.js web interface |
| Backend | 3001 | Express API server |
| Jellyfin | 8096 | Media streaming server |
| QBittorrent | 8888 | Torrent client (VPN-protected) |

### Frontend-Backend Communication

The frontend communicates with the backend via a RESTful HTTP API:

- **Frontend (port 3000)**: Serves the Next.js web application
- **Backend (port 3001)**: Provides API endpoints under `/api/*`

The frontend uses Next.js rewrites to proxy all `/api/*` requests to the backend.
This is configured at build time via the `BACKEND_URL` environment variable.

**API Endpoints:**
- `/api/media` - Media management (CRUD operations)
- `/api/media/:id/details` - Get detailed info for media details page
- `/api/media/:id/pin` - Pin media item for offline storage
- `/api/media/:id/unpin` - Unpin media item
- `/api/media/pinned` - Get all pinned media items
- `/api/media/tv/shows` - Get all TV shows (not individual episodes)
- `/api/media/tv/shows/:id` - Get a TV show with all its episodes
- `/api/media/tv/show/:title` - Delete entire TV show (all episodes)
- `/api/media/tv/show/:title/pin` - Pin all episodes of a TV show
- `/api/search` - OMDb and torrent search
- `/api/downloads` - Download management
- `/api/downloads/active` - Get active downloads only
- `/api/downloads/history` - Get download history (completed downloads)
- `/api/downloads/sync` - Trigger manual sync with QBittorrent
- `/api/settings` - VPN and system settings
- `/api/stats` - Disk and library statistics
- `/api/stats/disks` - Get disk storage information
- `/api/jellyfin` - Jellyfin integration (status, setup, token, redirect)
- `/api/scanner` - Content scanning and recovery
- `/api/scanner/status` - Get scanner status and progress
- `/api/scanner/scan` - Trigger content scan manually
- `/api/scanner/preview` - Preview scannable items without importing
- `/api/scanner/fix-images` - Fix items with missing poster images
- `/stream/movies/:title/:year` - Stream movies (serves file or redirects to progress)
- `/stream/tv/:title/:episode` - Stream TV episodes (e.g., `/stream/tv/stranger+things/s01e01`)
- `/stream/web/:title` - Stream web content

### Deleting Media

When media is deleted through Qar:

1. **Downloads are cancelled**: Any active downloads in QBittorrent are stopped
   and optionally deleted
2. **Content files are removed**: The `.strm` and `.yml` files are deleted from
   the content directory
3. **Empty directories are cleaned up**: For TV shows, empty season and show
   directories are removed; for movies, the movie directory is removed
4. **Database records are deleted**: The media item and associated download
   records are removed from the database

For TV shows, you can delete individual episodes or use the bulk delete endpoint
to remove the entire show at once.

## Development

### Running the Stack

```bash
# Start all services (excluding VPN/QBittorrent)
docker compose up -d --build

# Start with VPN/QBittorrent (requires VPN credentials in .env)
docker compose up -d --build pia-qbittorrent
```

### Configuring VPN for Development

1. Enter your PIA VPN credentials in the Settings page (http://localhost:3000/settings)
2. Click "Save Settings" to store credentials in the database
3. Click "Sync VPN Settings" to write credentials to the `.env` file
4. Start or restart the QBittorrent container:
   ```bash
   docker compose up -d pia-qbittorrent
   ```
5. The Settings page will show "Connected" once QBittorrent is available

### Testing

Tests are run inside Docker containers to ensure consistency:

```bash
# Run unit tests (includes TypeScript compilation check)
./backend/run-tests.sh

# Run integration tests (tests frontend-backend communication)
./backend/run-tests.sh integration

# View last test output
./backend/run-tests.sh last

# Run with coverage
./backend/run-tests.sh run --coverage
```

The test suite includes:
- **Unit tests**: Test individual components and configuration
- **Type checking**: TypeScript compilation to catch type errors
- **Integration tests**: Verify frontend and backend can communicate correctly
