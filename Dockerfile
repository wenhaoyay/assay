# One image for the API (+ built web app) and the demo agent; the command picks the role.
FROM node:22-slim AS web
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY pyproject.toml README.md ./
COPY assay ./assay
COPY examples ./examples
RUN pip install --no-cache-dir ".[postgres,pdf]"
COPY apps/api ./apps/api
COPY benchmarks ./benchmarks
COPY --from=web /web/dist ./apps/web/dist
# Run from the source tree so apps/, benchmarks/ and examples/ resolve the same way as in development.
RUN pip install --no-cache-dir --no-deps -e .
EXPOSE 8040 9040
CMD ["assay", "serve", "--host", "0.0.0.0", "--port", "8040"]
