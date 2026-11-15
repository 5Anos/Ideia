FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* bun.lock* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi

COPY . .

ENV NODE_ENV=production
ENV PORT=3000

RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
