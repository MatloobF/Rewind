# Rewind server: LLM proxy + REST API. Applies pending migrations on start
# (safe to repeat: migrate.js locks and skips applied files), then listens.
# Forks and evals spawn the agent in the run's cwd on the host, which doesn't
# exist in this container: run the server on the host for those.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY bin ./bin
COPY migrations ./migrations
EXPOSE 4000
CMD ["sh", "-c", "node src/migrate.js && exec node src/index.js"]
