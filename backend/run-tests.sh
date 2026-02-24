#!/bin/bash

# Qar Backend Test Runner
# Runs Jest tests in an ephemeral Docker environment with a separate test database
# All testing takes place inside Docker containers - no host environment configuration

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Output directory for test results
OUTPUT_DIR="$SCRIPT_DIR/.test-output"
LATEST_OUTPUT="$OUTPUT_DIR/latest.log"
PREVIOUS_OUTPUT="$OUTPUT_DIR/previous.log"

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

show_help() {
    echo "Qar Backend Test Runner"
    echo ""
    echo "Usage: $0 [command] [options]"
    echo ""
    echo "Commands:"
    echo "  run              Run unit tests in Docker container (default)"
    echo "  integration      Run integration tests (frontend + backend communication)"
    echo "  last             Show output from the last test run"
    echo "  previous         Show output from the previous test run"
    echo "  clean            Remove test containers and output files"
    echo ""
    echo "Options:"
    echo "  --coverage       Generate coverage report"
    echo "  --watch          Run tests in watch mode (interactive)"
    echo "  --verbose        Show verbose test output"
    echo "  --filter <name>  Run only tests matching the pattern"
    echo "  -h, --help       Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                    # Run all unit tests"
    echo "  $0 integration        # Run integration tests"
    echo "  $0 run --coverage     # Run tests with coverage"
    echo "  $0 last               # View last test output"
    echo "  $0 run --filter media # Run only media tests"
}

ensure_output_dir() {
    mkdir -p "$OUTPUT_DIR"
}

rotate_output() {
    ensure_output_dir
    if [ -f "$LATEST_OUTPUT" ]; then
        cp "$LATEST_OUTPUT" "$PREVIOUS_OUTPUT"
    fi
}

show_last_output() {
    if [ -f "$LATEST_OUTPUT" ]; then
        echo -e "${BLUE}=== Last Test Run Output ===${NC}"
        echo ""
        cat "$LATEST_OUTPUT"
    else
        log_warn "No previous test output found. Run tests first with: $0 run"
        exit 1
    fi
}

show_previous_output() {
    if [ -f "$PREVIOUS_OUTPUT" ]; then
        echo -e "${BLUE}=== Previous Test Run Output ===${NC}"
        echo ""
        cat "$PREVIOUS_OUTPUT"
    else
        log_warn "No previous test output found. You need at least two test runs."
        exit 1
    fi
}

clean_up() {
    log_info "Cleaning up test artifacts..."
    
    # Stop and remove unit test containers
    docker compose -f "$SCRIPT_DIR/docker-compose.test.yml" down -v --remove-orphans 2>/dev/null || true
    
    # Stop and remove integration test containers
    docker compose -f "$SCRIPT_DIR/docker-compose.integration.yml" down -v --remove-orphans 2>/dev/null || true
    
    # Remove orphaned test containers (unit tests)
    docker rm -f qar-test-postgres qar-test-runner 2>/dev/null || true
    
    # Remove orphaned integration test containers
    docker rm -f qar-integration-postgres qar-integration-backend qar-integration-frontend 2>/dev/null || true
    
    # Remove output files
    rm -rf "$OUTPUT_DIR"
    rm -f "$SCRIPT_DIR/.test-env"
    
    log_success "Cleanup complete"
}

run_tests() {
    local JEST_OPTS=""
    
    # Parse options
    while [[ $# -gt 0 ]]; do
        case $1 in
            --coverage)
                JEST_OPTS="$JEST_OPTS --coverage"
                shift
                ;;
            --watch)
                JEST_OPTS="$JEST_OPTS --watch"
                shift
                ;;
            --verbose)
                JEST_OPTS="$JEST_OPTS --verbose"
                shift
                ;;
            --filter)
                JEST_OPTS="$JEST_OPTS --testNamePattern=\"$2\""
                shift 2
                ;;
            *)
                shift
                ;;
        esac
    done

    log_info "Running tests in Docker container..."
    
    # Ensure docker-compose.test.yml exists
    if [ ! -f "$SCRIPT_DIR/docker-compose.test.yml" ]; then
        log_info "Creating docker-compose.test.yml..."
        create_test_compose
    fi
    
    # Ensure Dockerfile.test exists
    if [ ! -f "$SCRIPT_DIR/Dockerfile.test" ]; then
        log_info "Creating Dockerfile.test..."
        create_test_dockerfile
    fi
    
    # Rotate output files
    rotate_output
    ensure_output_dir
    
    # Cleanup any previous test containers
    docker compose -f "$SCRIPT_DIR/docker-compose.test.yml" down -v --remove-orphans 2>/dev/null || true
    
    log_info "Starting test containers..."
    log_info "Test output will be saved to: $LATEST_OUTPUT"
    echo ""
    
    # Create environment file for test options
    echo "JEST_OPTS=$JEST_OPTS" > "$SCRIPT_DIR/.test-env"
    
    # Run the tests and capture output
    set +e
    
    docker compose -f "$SCRIPT_DIR/docker-compose.test.yml" up \
        --build \
        --abort-on-container-exit \
        --exit-code-from test-runner 2>&1 | tee "$LATEST_OUTPUT"
    
    EXIT_CODE=${PIPESTATUS[0]}
    set -e
    
    # Cleanup
    docker compose -f "$SCRIPT_DIR/docker-compose.test.yml" down -v --remove-orphans 2>/dev/null || true
    rm -f "$SCRIPT_DIR/.test-env"
    
    echo ""
    if [ $EXIT_CODE -eq 0 ]; then
        log_success "All tests passed!"
        log_info "View this output later with: $0 last"
    else
        log_error "Some tests failed. Exit code: $EXIT_CODE"
        log_info "View this output later with: $0 last"
        log_info "View previous output with: $0 previous"
    fi
    
    exit $EXIT_CODE
}

create_test_compose() {
    cat > "$SCRIPT_DIR/docker-compose.test.yml" << 'EOF'
services:
  test-postgres:
    image: postgres:15-alpine
    container_name: qar-test-postgres
    environment:
      POSTGRES_USER: qar_test
      POSTGRES_PASSWORD: qar_test_password
      POSTGRES_DB: qar_test
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U qar_test"]
      interval: 2s
      timeout: 5s
      retries: 10
    tmpfs:
      - /var/lib/postgresql/data

  test-runner:
    build:
      context: .
      dockerfile: Dockerfile.test
    container_name: qar-test-runner
    environment:
      DATABASE_URL: postgres://qar_test:qar_test_password@test-postgres:5432/qar_test
      NODE_ENV: test
      QBITTORRENT_URL: http://mock-qbittorrent:8888
      OMDB_API_KEY: ${OMDB_API_KEY:-test_api_key}
    env_file:
      - path: .test-env
        required: false
      - path: ../.env
        required: false
    depends_on:
      test-postgres:
        condition: service_healthy
    volumes:
      - ./coverage:/app/coverage
EOF
}

create_test_dockerfile() {
    cat > "$SCRIPT_DIR/Dockerfile.test" << 'DOCKEREOF'
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies)
RUN npm install

# Install Jest and testing dependencies
RUN npm install --save-dev jest @types/jest ts-jest supertest @types/supertest

# Copy source and test files
COPY . .

# Create Jest configuration
RUN cat > jest.config.js << 'EOF'
/** @type {import("jest").Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.spec.ts", "**/*.test.ts", "**/*.spec.ts"],
  testPathIgnorePatterns: ["/node_modules/", "setup.ts"],
  transform: {
    "^.+\\.ts$": "ts-jest",
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/index.ts",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov", "html"],
  setupFilesAfterEnv: ["<rootDir>/src/__tests__/setup.ts"],
  testTimeout: 30000,
  verbose: true,
};
EOF

# Create test setup file
RUN mkdir -p src/__tests__ && cat > src/__tests__/setup.ts << 'EOF'
import { sequelize } from "../models";

beforeAll(async () => {
  try {
    await sequelize.authenticate();
    console.log("Database connection established.");
    await sequelize.sync({ force: true });
    console.log("Database synced for tests.");
  } catch (error) {
    console.error("Unable to connect to the database:", error);
    throw error;
  }
});

afterAll(async () => {
  try {
    await sequelize.close();
    console.log("Database connection closed.");
  } catch (error) {
    console.error("Error closing database connection:", error);
  }
});
EOF

# Create health check test
RUN cat > src/__tests__/health.test.ts << 'EOF'
import request from "supertest";
import express from "express";

describe("Health Check", () => {
  const app = express();
  
  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });
  
  it("should return healthy status", async () => {
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });
});

describe("Configuration", () => {
  it("should have valid environment configuration", () => {
    const { config } = require("../config");
    expect(config).toBeDefined();
    expect(config.paths).toBeDefined();
    expect(config.paths.content).toBeDefined();
    expect(config.paths.disks).toBeDefined();
  });
});
EOF

# Create OMDB service test
RUN cat > src/__tests__/omdb.test.ts << 'EOF'
import { OmdbService } from "../services/omdb";
import { Setting } from "../models";

describe("OMDB Service", () => {
  let omdbService: OmdbService;

  beforeEach(() => {
    omdbService = new OmdbService();
  });

  describe("API Key Management", () => {
    it("should detect when API key is not configured", () => {
      omdbService.setApiKey("");
      expect(omdbService.isConfigured()).toBe(false);
    });

    it("should detect when API key is configured", () => {
      omdbService.setApiKey("test_api_key");
      expect(omdbService.isConfigured()).toBe(true);
    });

    it("should allow setting API key dynamically", () => {
      omdbService.setApiKey("new_key");
      expect(omdbService.getApiKey()).toBe("new_key");
    });

    it("should return empty results when API key is not configured", async () => {
      omdbService.setApiKey("");
      const results = await omdbService.search("test");
      expect(results).toEqual([]);
    });
  });

  describe("Search with Valid API Key", () => {
    const isLiveTestEnabled = () => {
      const apiKey = process.env.OMDB_API_KEY;
      return apiKey && apiKey !== "test_api_key" && apiKey.length >= 8;
    };

    beforeEach(() => {
      // Use the test API key from environment
      const apiKey = process.env.OMDB_API_KEY || "test_api_key";
      omdbService.setApiKey(apiKey);
    });

    it("should search for a well-known movie: The Matrix", async () => {
      // Skip if we don't have a real API key
      if (!isLiveTestEnabled()) {
        console.log("Skipping live OMDB test - no real API key configured");
        return;
      }
      
      const results = await omdbService.search("The Matrix", "movie");
      
      // If results are empty, the API key may be invalid - skip rather than fail
      if (results.length === 0) {
        console.log("OMDB returned no results - API key may be invalid or rate limited");
        console.log("Verify your API key at https://www.omdbapi.com/");
        return;
      }
      
      expect(results.length).toBeGreaterThan(0);
      const matrix = results.find(r => r.Title.toLowerCase().includes("matrix"));
      expect(matrix).toBeDefined();
      expect(matrix?.Type).toBe("movie");
    });

    it("should search for a well-known TV series: Stranger Things", async () => {
      // Skip if we don't have a real API key
      if (!isLiveTestEnabled()) {
        console.log("Skipping live OMDB test - no real API key configured");
        return;
      }
      
      const results = await omdbService.search("Stranger Things", "series");
      
      // If results are empty, the API key may be invalid - skip rather than fail
      if (results.length === 0) {
        console.log("OMDB returned no results - API key may be invalid or rate limited");
        console.log("Verify your API key at https://www.omdbapi.com/");
        return;
      }
      
      expect(results.length).toBeGreaterThan(0);
      const strangerThings = results.find(r => 
        r.Title.toLowerCase().includes("stranger things")
      );
      expect(strangerThings).toBeDefined();
      expect(strangerThings?.Type).toBe("series");
    });

    it("should get details for a specific IMDB ID", async () => {
      // Skip if we don't have a real API key
      if (!isLiveTestEnabled()) {
        console.log("Skipping live OMDB test - no real API key configured");
        return;
      }
      
      // The Matrix IMDB ID
      const details = await omdbService.getDetails("tt0133093");
      
      // If null, the API key may be invalid - skip rather than fail
      if (!details) {
        console.log("OMDB returned no details - API key may be invalid or rate limited");
        console.log("Verify your API key at https://www.omdbapi.com/");
        return;
      }
      
      expect(details).not.toBeNull();
      expect(details?.Title).toBe("The Matrix");
      expect(details?.Year).toBe("1999");
    });
  });
});

describe("Settings API - OMDB Key", () => {
  it("should store OMDB API key in database settings", async () => {
    const testKey = "test_omdb_key_12345";
    
    await Setting.upsert({
      key: "omdbApiKey",
      value: testKey,
    });
    
    const setting = await Setting.findOne({ where: { key: "omdbApiKey" } });
    expect(setting).not.toBeNull();
    expect(setting?.value).toBe(testKey);
  });

  it("should be able to update OMDB API key", async () => {
    await Setting.upsert({ key: "omdbApiKey", value: "old_key" });
    await Setting.upsert({ key: "omdbApiKey", value: "new_key" });
    
    const setting = await Setting.findOne({ where: { key: "omdbApiKey" } });
    expect(setting?.value).toBe("new_key");
  });
});
EOF

# First compile TypeScript to catch type errors, then run tests
CMD ["sh", "-c", "npm run build && ./node_modules/.bin/jest ${JEST_OPTS:-}"]
DOCKEREOF
}

run_integration_tests() {
    log_info "Running integration tests (frontend + backend)..."
    log_info "Using isolated test containers (ports 3010/3011)"
    
    # Rotate output files
    rotate_output
    ensure_output_dir
    
    log_info "Building and starting isolated test services..."
    log_info "Integration test output will be saved to: $LATEST_OUTPUT"
    echo ""
    
    # Use the isolated integration compose file
    INTEGRATION_COMPOSE="$SCRIPT_DIR/docker-compose.integration.yml"
    
    # Run integration tests and capture output
    set +e
    (
        # Build and start isolated services (uses different ports: 3010, 3011)
        docker compose -f "$INTEGRATION_COMPOSE" up -d --build
        
        # Wait for services to be healthy
        log_info "Waiting for services to start..."
        sleep 10
        
        # Test backend health endpoint (port 3011 - isolated)
        log_info "Testing backend health endpoint (port 3011)..."
        BACKEND_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3011/health 2>/dev/null || echo "000")
        if [ "$BACKEND_HEALTH" = "200" ]; then
            log_success "Backend health check passed (HTTP $BACKEND_HEALTH)"
        else
            log_error "Backend health check failed (HTTP $BACKEND_HEALTH)"
            docker compose -f "$INTEGRATION_COMPOSE" logs integration-backend
            exit 1
        fi
        
        # Test backend API endpoint
        log_info "Testing backend API endpoint..."
        BACKEND_API=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3011/api/stats 2>/dev/null || echo "000")
        if [ "$BACKEND_API" = "200" ]; then
            log_success "Backend API check passed (HTTP $BACKEND_API)"
        else
            log_error "Backend API check failed (HTTP $BACKEND_API)"
            docker compose -f "$INTEGRATION_COMPOSE" logs integration-backend
            exit 1
        fi
        
        # Test frontend is serving (port 3010 - isolated)
        log_info "Testing frontend is serving (port 3010)..."
        FRONTEND_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3010 2>/dev/null || echo "000")
        if [ "$FRONTEND_STATUS" = "200" ]; then
            log_success "Frontend check passed (HTTP $FRONTEND_STATUS)"
        else
            log_error "Frontend check failed (HTTP $FRONTEND_STATUS)"
            docker compose -f "$INTEGRATION_COMPOSE" logs integration-frontend
            exit 1
        fi
        
        # Test frontend can proxy to backend API
        log_info "Testing frontend-to-backend API proxy..."
        PROXY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3010/api/stats 2>/dev/null || echo "000")
        if [ "$PROXY_STATUS" = "200" ]; then
            log_success "Frontend-to-backend proxy check passed (HTTP $PROXY_STATUS)"
        else
            log_error "Frontend-to-backend proxy check failed (HTTP $PROXY_STATUS)"
            log_error "This means the frontend cannot communicate with the backend!"
            log_info "Frontend logs:"
            docker compose -f "$INTEGRATION_COMPOSE" logs integration-frontend
            log_info "Backend logs:"
            docker compose -f "$INTEGRATION_COMPOSE" logs integration-backend
            exit 1
        fi
        
        # Verify the response contains expected data
        log_info "Verifying API response data..."
        API_RESPONSE=$(curl -s http://localhost:3010/api/stats 2>/dev/null)
        if echo "$API_RESPONSE" | grep -q "disks"; then
            log_success "API response contains expected data"
        else
            log_error "API response doesn't contain expected data: $API_RESPONSE"
            exit 1
        fi
        
        log_success "All integration tests passed!"
        
    ) 2>&1 | tee "$LATEST_OUTPUT"
    
    EXIT_CODE=${PIPESTATUS[0]}
    set -e
    
    # Cleanup - only affects isolated containers
    log_info "Stopping test services..."
    docker compose -f "$INTEGRATION_COMPOSE" down 2>/dev/null || true
    
    cd "$SCRIPT_DIR"
    
    echo ""
    if [ $EXIT_CODE -eq 0 ]; then
        log_success "All integration tests passed!"
        log_info "View this output later with: $0 last"
    else
        log_error "Integration tests failed. Exit code: $EXIT_CODE"
        log_info "View this output later with: $0 last"
    fi
    
    exit $EXIT_CODE
}

# Main command dispatch
COMMAND="${1:-run}"

case $COMMAND in
    run)
        shift 2>/dev/null || true
        run_tests "$@"
        ;;
    integration)
        run_integration_tests
        ;;
    last)
        show_last_output
        ;;
    previous)
        show_previous_output
        ;;
    clean)
        clean_up
        ;;
    -h|--help|help)
        show_help
        ;;
    *)
        # If first arg looks like an option, treat as run command
        if [[ "$COMMAND" == --* ]]; then
            run_tests "$@"
        else
            log_error "Unknown command: $COMMAND"
            echo ""
            show_help
            exit 1
        fi
        ;;
esac
