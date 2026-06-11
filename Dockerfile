FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
# The line below now copies EVERYTHING in your folder
COPY . .
CMD ["node", "index.js"]
