# Qar

**Qar** is a self-hosted, all-in-one media management system for Linux. It provides an easy-to-use web interface for discovering, downloading, and streaming Movies, TV shows, and Web content — all with built-in VPN protection for privacy.

## Features

- 🎬 **One-click media discovery** — Search for movies and TV shows by name, powered by OMDB
- 📺 **Jellyfin integration** — Automatically configured media server with zero manual setup
- 🔒 **VPN-protected downloads** — QBittorrent runs inside an isolated WireGuard VPN namespace (PIA)
- 🌐 **Tor-routed search** — Torrent searches go through Tor for privacy, with clearnet fallback
- 📦 **Smart downloads** — Automatic quality selection, per-episode priority, incremental processing
- 💾 **Multi-disk support** — Span your library across multiple drives with automatic allocation
- 🔄 **Content recovery** — Scan and rebuild your library from existing files on disk
- 📱 **Progress videos** — See live download progress inside Jellyfin while content downloads

## Quick Start

### Install on Debian / Ubuntu

```bash
# Add the Jellyfin repository (required dependency)
curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/jellyfin.gpg
echo "deb [signed-by=/usr/share/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/jellyfin.list

# Add the Qar repository
curl -fsSL https://devrupt-io.github.io/qar/KEY.gpg | sudo gpg --dearmor -o /usr/share/keyrings/qar.gpg
echo "deb [signed-by=/usr/share/keyrings/qar.gpg] https://devrupt-io.github.io/qar stable main" | sudo tee /etc/apt/sources.list.d/qar.list

# Install
sudo apt update
sudo apt install qar
```

Or install directly from a `.deb` file:

```bash
sudo dpkg -i qar_1.0.1_amd64.deb
sudo apt-get install -f    # Resolve dependencies
```

### Install on RHEL / Fedora

```bash
# Add RPM Fusion repository (provides Jellyfin)
sudo dnf install -y https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm

# Add the Qar repository
sudo rpm --import https://devrupt-io.github.io/qar/rpm/KEY.gpg
sudo tee /etc/yum.repos.d/qar.repo <<EOF
[qar]
name=Qar - Self-hosted media management
baseurl=https://devrupt-io.github.io/qar/rpm/packages
enabled=1
gpgcheck=1
gpgkey=https://devrupt-io.github.io/qar/rpm/KEY.gpg
EOF

# Install
sudo dnf install qar
```

Or install directly from an `.rpm` file:

```bash
sudo rpm -i qar-1.0.1.x86_64.rpm
```

### Configure

Edit `/etc/qar/qar.conf` to set your API keys and preferences:

```bash
sudo nano /etc/qar/qar.conf
```

Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `DB_DIALECT` | `sqlite` | Database engine (`sqlite` or `postgres`) |
| `OMDB_API_KEY` | *(empty)* | [OMDB API key](https://www.omdbapi.com/apikey.aspx) for movie/TV metadata |
| `JELLYFIN_URL` | `http://127.0.0.1:8096` | Jellyfin server URL |
| `QBITTORRENT_URL` | `http://127.0.0.1:8888` | QBittorrent WebUI URL |
| `CONTENT_PATH` | `/qar/content` | Directory for `.strm` and metadata files |
| `DOWNLOADS_PATH` | `/qar/downloads` | Active download directory |

### Start

```bash
sudo systemctl start qar-backend
```

This automatically starts all dependent services (frontend, QBittorrent, VPN). Open your browser to **http://localhost:3000** to get started.

### Verify

```bash
sudo systemctl status qar-backend qar-frontend qar-vpn qar-qbittorrent jellyfin
```

## Architecture

Qar is composed of five services managed by systemd:

| Service | Port | Description |
|---------|------|-------------|
| `qar-frontend` | 3000 | Next.js web interface |
| `qar-backend` | 3001 | Express API server (TypeScript + Sequelize) |
| `jellyfin` | 8096 | Media streaming server (auto-configured) |
| `qar-qbittorrent` | 8888 | Torrent client (runs inside VPN namespace) |
| `qar-vpn` | — | WireGuard VPN namespace manager (PIA) |

### How It Works

1. **You search** for a movie or TV show in the web UI
2. **Qar finds** matching content via OMDB and torrent sources (via Tor)
3. **QBittorrent downloads** the content through an encrypted VPN tunnel
4. **Files are organized** into your library across your storage disks
5. **Jellyfin serves** the content for playback on any device

### Storage Layout

```
/qar/
├── content/          # .strm and .yml metadata files (lightweight, shareable)
│   ├── movies/
│   ├── tv/
│   └── web/
├── downloads/        # Active QBittorrent downloads (temporary)
├── disks/            # External storage drives (optional)
│   ├── default/      # Default storage if no external disks
│   ├── disk1/        # External drive mount points
│   └── disk2/
├── config/           # Service configuration files
│   └── qBittorrent/  # QBittorrent settings
└── data/
    └── qar.db        # SQLite database (default)
```

Media files are stored in the `disks/` directory. The `content/` directory contains only lightweight `.strm` files that point to actual media — making it easy to back up or share your library.

**File structure:**
- Movies: `disks/<disk>/movies/<Title> (<Year>)/<file>.mkv`
- TV: `disks/<disk>/tv/<Show>/Season <N>/<file>.mkv`
- Web: `disks/<disk>/web/<Channel>/<file>.mkv`

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
title: Night of the Living Dead
year: 1968
imdbId: tt0063350
magnetUri: null
season: null
episode: null
addedAt: 2026-01-01T00:00:00.000Z
posterUrl: https://example.com/poster.jpg
plot: A ragtag group of barricade themselves in an old farmhouse to remain safe from a horde of flesh-eating ghouls that are ravaging the Northeast of the United States.
scannedAt: 2026-01-01T01:00:00.000Z
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

- **Movies**: `http://localhost:3001/progress/movies/{title-slug}/{year}`
- **TV Shows**: `http://localhost:3001/progress/tv/{title-slug}/s{season}e{episode}`
- **Web**: `http://localhost:3001/progress/web/{title-slug}`

The slug is created by converting the title to lowercase and replacing
non-alphanumeric characters with `+`.

The progress video is generated using FFmpeg with a dark themed background
at 1280x720 resolution and minimal CPU usage (1fps, static image encoding).

#### Phase 2: Direct Paths (After Download Completion)

Once a download completes and the file is moved to storage, the `.strm` file is
automatically updated to contain a direct path to the video file:

Direct paths point to Jellyfin's storage mount, allowing it to:
- Analyze the file format and codecs
- Enable direct play without transcoding
- Provide faster seeking and better playback performance

After the `.strm` file is updated, the backend automatically triggers a Jellyfin
library refresh for that specific item so the change takes effect immediately.

#### Storage Architecture

- `content/` → Jellyfin content library: Contains `.strm` and `.yml` metadata files
- `disks/` → Jellyfin storage library: Contains actual video files after download

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

## VPN Protection

Qar runs QBittorrent inside an isolated Linux network namespace with a WireGuard tunnel to PIA (Private Internet Access). This ensures **all torrent traffic** is encrypted and routed through the VPN — with a kill switch that blocks traffic if the VPN disconnects.

### How VPN Isolation Works

```
Host Network                    VPN Namespace (qarvpn)
┌─────────────┐    veth pair    ┌──────────────────────┐
│  Frontend    │◄──────────────►│  QBittorrent :8888   │
│  Backend     │   10.200.200.x │  WireGuard tunnel    │──► PIA VPN
│  Jellyfin    │                │  (kill switch active) │
│  socat :8888 │                └──────────────────────┘
└─────────────┘
```

- The `qar-vpn` service creates a network namespace, establishes a WireGuard tunnel, and runs `socat` to forward port 8888 from the host into the namespace
- The `qar-qbittorrent` service runs inside the namespace — it can only reach the internet through the VPN
- If the VPN disconnects, the namespace has no default route, so traffic is blocked (kill switch)

### Configuring VPN Credentials

1. Open the Qar web UI at **http://localhost:3000/settings**
2. Enter your PIA VPN username and password
3. Select a VPN region
4. Click **Apply VPN Settings** — the VPN and QBittorrent services restart automatically

You can verify isolation by comparing IPs:

```bash
# Host IP (your real IP)
curl -s ifconfig.me

# VPN namespace IP (should be different)
sudo ip netns exec qarvpn curl -s ifconfig.me
```

## Docker Services

Qar uses a `docker-compose.yml` for development and testing. The Docker stack mirrors the native Linux services:

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

The `./config/.env` file is managed by the backend and contains VPN credentials
(`USER`, `PASSWORD`, `REGION`). These are configured through the web interface at
**http://localhost:3000/settings**.

> **Note**: The Docker stack uses the [j4ym0/pia-qbittorrent](https://hub.docker.com/r/j4ym0/pia-qbittorrent) image which handles VPN tunneling internally. The `config/post-vpn-connect.sh` hook script configures Docker-specific routing and authentication bypass. For native installs, the `qar-vpn` service handles this automatically.

## Backend

The backend is written in TypeScript using Express and Sequelize. It supports
both SQLite (default for native installs) and PostgreSQL (used in Docker).

Tor is installed for private torrent searches via hidden service (.onion),
with automatic fallback to clearnet mirrors.

The backend automates media search via the OMDB API, enabling users to find and
add movies and TV shows through the web interface.

### Torrent Search

The torrent search functionality connects to torrent search providers to find download sources:

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

Downloads are handled via torrent search providers using Tor for privacy.

When a request comes in to play a movie or TV show (via a URL that was in a
`.strm` file from Jellyfin) and the content hasn't been downloaded yet, the
backend serves a progress video showing the download status. Once downloaded,
the `.strm` file is updated to point directly to the file for optimal playback.

Download information is saved in the database, and the magnet URL is passed to
QBittorrent. When the download completes, the file is moved to the appropriate
media disk (or default storage if no external disks are configured). If a TV
show already exists on a disk, new episodes are stored alongside it.

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
     file instead of the progress video URL
   - **Jellyfin is notified** to refresh the media item so it recognizes the
     updated `.strm` file and can enable direct play

6. **Recovery Handling**: The download manager also handles edge cases:
   - If a download was marked complete but the file wasn't moved (e.g., due to
     a service restart), it will be re-processed on the next sync
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

## Frontend

The frontend is a Next.js web application that communicates exclusively with the
backend API — it does not talk to QBittorrent or Jellyfin directly.

### Error Handling

The frontend implements comprehensive error handling to prevent crashes:

- **Global Error Boundary**: Next.js error pages (`error.tsx` and
  `global-error.tsx`) catch unhandled errors and display user-friendly error
  messages with retry options
- **Page-level Error Boundaries**: Individual pages like media details wrap
  their content in error boundaries to prevent cascading failures
- **Graceful Degradation**: API errors are caught and displayed to users with
  helpful messages rather than crashing the application

The homepage provides a search box for quickly finding movies and TV shows to add
to the library.

### Library Grid

The library page displays media items in a responsive grid. Clicking any item
navigates to the media details page. The grid shows:

- Media poster (or type icon if no poster)
- Title with year/episode info
- Status badge (Available, Downloading %, Pending, etc.)
- Pinned indicator

**Note**: The grid uses a clean design without hover overlays or action icons.
All actions are available on the media details page.

The frontend shows disk statistics so users know when they need to expand
storage, and provides settings for VPN credentials, bandwidth limits, and more.

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
- Media libraries pointing to the content directory (Movies, TV, Web)
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
server with no manual configuration.

The redirect flow:
1. User clicks "Watch" button
2. Frontend redirects to `/jellyfin-redirect` page
3. Page calls `/api/jellyfin/status` to check if Jellyfin is ready
4. If not configured, page calls `/api/jellyfin/setup` to auto-configure
5. Page gets an access token via `/api/jellyfin/token`
6. Page redirects to `http://localhost:8096/web/qar-login.html`
7. The qar-login.html page sets Jellyfin credentials in localStorage and redirects to the Jellyfin home page

## API Reference

The frontend communicates with the backend via a RESTful HTTP API. The frontend
uses Next.js rewrites to proxy all `/api/*` requests to the backend.

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
- `/api/search` - OMDB and torrent search
- `/api/downloads` - Download management
- `/api/downloads/active` - Get active downloads only
- `/api/downloads/history` - Get download history (completed downloads)
- `/api/downloads/sync` - Trigger manual sync with QBittorrent
- `/api/settings` - VPN and system settings
- `/api/stats` - Disk and library statistics
- `/api/stats/disks` - Get disk storage information
- `/api/jellyfin` - Jellyfin integration (status, setup, token, redirect)
- `/api/scanner` - Content scanning and recovery
- `/stream/movies/:title/:year` - Stream movies
- `/stream/tv/:title/:episode` - Stream TV episodes
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

## Configuration

### Configuration File

Native installs use `/etc/qar/qar.conf`. All settings are environment variable
format (`KEY=value`). The full list of settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `DB_DIALECT` | `sqlite` | Database engine: `sqlite` or `postgres` |
| `SQLITE_PATH` | `/qar/data/qar.db` | SQLite database file path |
| `DATABASE_URL` | *(commented out)* | PostgreSQL connection string |
| `JELLYFIN_URL` | `http://127.0.0.1:8096` | Jellyfin server URL |
| `QBITTORRENT_URL` | `http://127.0.0.1:8888` | QBittorrent WebUI URL |
| `OMDB_API_KEY` | *(empty)* | [OMDB API key](https://www.omdbapi.com/apikey.aspx) for metadata |
| `OPENROUTER_API_KEY` | *(empty)* | OpenRouter key for AI recommendations |
| `CONTENT_PATH` | `/qar/content` | Directory for `.strm` and metadata files |
| `DOWNLOADS_PATH` | `/qar/downloads` | Active download directory |
| `DISKS_PATH` | `/qar/disks` | External storage mount points |
| `JELLYFIN_MEDIA_PATH` | `/qar/content` | Path where Jellyfin accesses content |

### Switching to PostgreSQL

To use PostgreSQL instead of SQLite:

```bash
sudo nano /etc/qar/qar.conf
# Set: DB_DIALECT=postgres
# Uncomment: DATABASE_URL=postgres://qar:password@localhost:5432/qar
sudo systemctl restart qar-backend
```

### Managing Services

```bash
# Start everything
sudo systemctl start qar-backend

# Check status of all services
sudo systemctl status qar-backend qar-frontend qar-vpn qar-qbittorrent

# Restart VPN (e.g., after changing VPN region)
sudo systemctl restart qar-vpn qar-qbittorrent

# View logs
sudo journalctl -u qar-backend -f
sudo journalctl -u qar-vpn -f
```

## Building from Source

### Prerequisites

- Node.js >= 18
- [nfpm](https://nfpm.goreleaser.com/install/) for package generation

### Build Packages

```bash
./packaging/build.sh          # Build both .deb and .rpm
./packaging/build.sh deb      # Build only .deb
./packaging/build.sh rpm      # Build only .rpm
```

Packages are output to `dist/packages/`.

### Testing Packages with QEMU

A QEMU test harness is included for testing packages in a clean VM:

```bash
./packaging/qemu-test.sh create    # Create a Debian 12 VM
./packaging/qemu-test.sh start     # Boot the VM
./packaging/qemu-test.sh deploy    # Build and install the .deb
./packaging/qemu-test.sh ssh       # SSH into the VM
./packaging/qemu-test.sh status    # Check all services
./packaging/qemu-test.sh stop      # Shut down the VM
./packaging/qemu-test.sh destroy   # Remove the VM
```

### Versioning

Qar uses [semantic versioning](https://semver.org/). The current version is
stored in the `VERSION` file at the repository root.

## Development

Docker is used for local development and testing.

### Running the Stack

```bash
cp example.env .env
# Edit .env with your API keys

# Start all services
docker compose up -d --build

# Start with VPN/QBittorrent (requires VPN credentials in .env)
docker compose up -d --build pia-qbittorrent
```

The frontend is available at http://localhost:3000 and Jellyfin at
http://localhost:8096.

### Configuring VPN for Development

1. Enter your PIA VPN credentials in the Settings page (http://localhost:3000/settings)
2. Click "Save Settings" to store credentials in the database
3. Click "Sync VPN Settings" to write credentials to the `.env` file
4. Start or restart QBittorrent:
   ```bash
   docker compose up -d pia-qbittorrent
   ```
5. The Settings page will show "Connected" once QBittorrent is available

### Testing

```bash
# Run unit tests (includes TypeScript compilation check)
./backend/run-tests.sh

# Run integration tests (tests frontend-backend communication)
./backend/run-tests.sh integration

# Run with coverage
./backend/run-tests.sh run --coverage
```

The test suite includes:
- **Unit tests**: Test individual components and configuration
- **Type checking**: TypeScript compilation to catch type errors
- **Integration tests**: Verify frontend and backend can communicate correctly

## License

MIT
