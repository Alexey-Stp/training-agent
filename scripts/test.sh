#!/bin/bash
set -e

echo "Running tests..."

# Test core package
echo "Testing @triathlon/core..."
npm run test -w @triathlon/core

echo "All tests passed!"
