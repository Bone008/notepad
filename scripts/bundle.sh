#!/usr/bin/env bash
# Builds the client and server and packs a self-contained release tarball.
# The tarball needs only Node.js (>= 24) on the target; no node_modules, no Docker.
# Prints the tarball path on stdout; everything else goes to stderr.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build >&2

version=$(node -p "require('./package.json').version || '0.0.0'")
stamp=$(date -u +%Y%m%d%H%M%S)
name="notepad-${version}-${stamp}"
stage="dist/bundle/${name}"

rm -rf dist/bundle
mkdir -p "${stage}/server" "${stage}/client"
cp -R server/dist "${stage}/server/dist"
cp -R client/dist "${stage}/client/dist"
cp deploy/ecosystem.config.cjs "${stage}/"
cp .env.example "${stage}/"
# "type": "module" is required because server/dist/index.js is an ES module.
printf '{\n  "name": "notepad",\n  "version": "%s",\n  "private": true,\n  "type": "module"\n}\n' "${version}" > "${stage}/package.json"
echo "${name}" > "${stage}/VERSION"

mkdir -p dist
tar -czf "dist/${name}.tar.gz" -C dist/bundle "${name}"
rm -rf dist/bundle
echo "bundle: dist/${name}.tar.gz ($(du -h "dist/${name}.tar.gz" | cut -f1))" >&2
echo "dist/${name}.tar.gz"
