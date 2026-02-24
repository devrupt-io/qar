FROM node:20-alpine AS builder

WORKDIR /app

# Backend URL for API rewrites - set at build time
ARG BACKEND_URL=http://backend:3001
ENV BACKEND_URL=${BACKEND_URL}

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source
COPY . .

# Build the application with BACKEND_URL available
RUN npm run build

# Production image
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV production

# Backend URL for API rewrites
ARG BACKEND_URL=http://backend:3001
ENV BACKEND_URL=${BACKEND_URL}

# Copy necessary files from builder
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000

ENV PORT 3000

CMD ["node", "server.js"]
