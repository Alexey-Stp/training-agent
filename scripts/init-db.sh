#!/bin/bash
set -e

echo "Waiting for PostgreSQL to be ready..."
until docker compose exec -T postgres pg_isready -U postgres > /dev/null 2>&1; do
  sleep 1
done

echo "PostgreSQL is ready!"
echo "Pushing Prisma schema..."
docker compose exec -T bot npx prisma db push --skip-generate

echo "Database initialized successfully!"
