FROM ghcr.io/puppeteer/puppeteer:23.11.1

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies as root
USER root
RUN npm ci --only=production

# Copy application files
COPY . .

# Switch back to pptruser (non-root user for security)
USER pptruser

EXPOSE 3000

CMD ["node", "index.js"]
