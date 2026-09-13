FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

VOLUME ["/app/data"]

CMD ["node", "server.js"]
