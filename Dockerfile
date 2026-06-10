FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY court-bot.js .
CMD ["node", "court-bot.js"]
