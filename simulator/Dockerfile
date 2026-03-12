FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production 2>/dev/null; true

COPY *.js ./

EXPOSE 44818

CMD ["node", "server.js"]
