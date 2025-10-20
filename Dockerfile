FROM ghcr.io/puppeteer/puppeteer:23.11.1

WORKDIR /app

COPY package*.json ./
USER root
RUN npm ci --only=production

COPY . .

USER pptruser

EXPOSE 10000

CMD ["node", "index.js"]