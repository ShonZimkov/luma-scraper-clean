# Use Puppeteer base image with Chrome pre-installed
FROM ghcr.io/puppeteer/puppeteer:23.11.1

# Set working directory
WORKDIR /app

# Copy dependencies and install
COPY package*.json ./
USER root
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# Use non-root user for security
USER pptruser

EXPOSE 3000

# Start the app
CMD ["node", "index.js"]