FROM node:18-slim

# Install minimal deps for Chromium
RUN apt-get update && apt-get install -y \
  ca-certificates fonts-liberation libnss3 libxss1 lsb-release wget gnupg2 \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Optionally install system chromium to avoid puppeteer's download during npm install
RUN apt-get update && apt-get install -y chromium --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY . .

# If using system chromium, set CHROME_PATH env in Render to '/usr/bin/chromium'
EXPOSE 3000
USER node
CMD ["node","server.js"]
