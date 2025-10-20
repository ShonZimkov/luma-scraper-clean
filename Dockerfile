FROM ghcr.io/puppeteer/puppeteer:23.11.1

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (production only)
USER root
RUN npm ci --only=production

# Copy the rest of the project files
COPY . .

# Switch back to non-root Puppeteer user
USER pptruser

EXPOSE 10000

CMD ["node", "index.js"]