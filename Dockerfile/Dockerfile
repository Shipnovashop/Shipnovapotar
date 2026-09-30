FROM node:22-alpine AS build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/scripts ./scripts
RUN npm run build

FROM node:22-alpine
WORKDIR /app/backend
ENV NODE_ENV=production
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/scripts ./scripts
COPY database /app/database
EXPOSE 4000
CMD ["node", "dist/server.js"]
