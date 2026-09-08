# Deterministic runtime for reviewers without Node 22.13+ on the host.
FROM node:24-alpine
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY test ./test
ENV PORT=3000 DATA_PATH=/data/ottodot.sqlite
VOLUME /data
EXPOSE 3000
# No npm install: zero runtime dependencies.
CMD ["node", "--experimental-strip-types", "--no-warnings=ExperimentalWarning", "src/server.ts"]
