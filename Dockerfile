FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
RUN mkdir -p /data
# No VOLUME line: Railway rejects it. Attach a volume at /data in the host instead (docker run -v also works).
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
