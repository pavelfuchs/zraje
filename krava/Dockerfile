FROM node:20-alpine
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci --production
COPY server.js ./
COPY index.html style.css ./
COPY fonts/ ./fonts/
COPY assets/ ./assets/
COPY admin/ ./admin/
EXPOSE 8080
CMD ["node", "server.js"]
