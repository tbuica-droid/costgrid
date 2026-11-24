#!/bin/sh
# Installs the marketing-site function dependencies. vercel.json's
# installCommand must stay within 256 characters, so the steps live here.
# The working directory may be the repo root or a function folder.
set -e
dir=$(pwd)
while [ ! -f "$dir/vercel.json" ] && [ "$dir" != "/" ]; do
  dir=$(dirname "$dir")
done
cd "$dir"
rm -rf /tmp/cg-fn
mkdir -p /tmp/cg-fn
npm init -y --prefix /tmp/cg-fn >/dev/null
npm install --prefix /tmp/cg-fn --omit=dev --ignore-scripts --no-audit --no-fund stripe@23.2.0 @supabase/supabase-js@2.117.1
rm -rf node_modules
mkdir -p node_modules
cp -a /tmp/cg-fn/node_modules/. node_modules/
if [ -f api/package.json ]; then
  npm install --prefix api --omit=dev --ignore-scripts --no-audit --no-fund
fi
