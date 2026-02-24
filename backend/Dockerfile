FROM node:20-alpine

# Install Tor, ffmpeg, and fonts for progress video generation
# Note: Docker CLI is not needed - we use the Docker Engine API directly via Unix socket
RUN apk add --no-cache tor ffmpeg fontconfig ttf-dejavu

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Start Tor in background and run the server
CMD tor & sleep 5 && node dist/index.js
