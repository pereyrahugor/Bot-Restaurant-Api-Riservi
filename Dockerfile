# Step 1: Builder
FROM node:20-slim AS builder

WORKDIR /app

# Copy only what's needed for installation to leverage cache
COPY package.json package-lock.json* ./

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git ca-certificates poppler-utils \
    && update-ca-certificates

# Install all dependencies (including devDeps for build)
RUN npm install

# Copy context - using .dockerignore to filter
COPY . .

# Build the project
RUN npm run build

# Step 2: Deploy
FROM node:20-slim AS deploy

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils git openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built code and required assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json* ./
COPY --from=builder /app/src/assets ./src/assets
COPY --from=builder /app/src/js ./src/js
COPY --from=builder /app/src/style ./src/style
COPY --from=builder /app/src/html ./src/html
# Also copy html files from src root
COPY --from=builder /app/src/*.html ./src/

# Install ONLY production dependencies
RUN npm install --omit=dev --ignore-scripts

ENV PORT=3000
EXPOSE 3000

# Create required directories
RUN mkdir -p /app/credentials /app/bot_sessions /app/tmp

# Standard start command
CMD ["npm", "start"]