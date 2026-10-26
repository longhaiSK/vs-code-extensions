#!/bin/zsh
# Show the Open VSX status of this extension: published version vs local, downloads, rating.
set -e

EXT="Prof-LonghaiLi/qmd2typ-pro"
LOCAL_VERSION=$(node -p "require('./package.json').version")

JSON=$(curl -sf "https://open-vsx.org/api/$EXT") || { echo "Could not reach Open VSX for $EXT"; exit 1; }

node -e '
const d = JSON.parse(process.argv[1]);
const local = process.argv[2];
console.log(`Extension:   ${d.namespace}.${d.name}`);
console.log(`Published:   ${d.version}  (${d.timestamp})`);
console.log(`Local:       ${local}  ${d.version === local ? "(in sync)" : "(NOT yet published)"}`);
console.log(`Downloads:   ${d.downloadCount}`);
console.log(`Reviews:     ${d.reviewCount}  rating: ${d.averageRating ?? "n/a"}`);
console.log(`Page:        https://open-vsx.org/extension/${d.namespace}/${d.name}`);
' "$JSON" "$LOCAL_VERSION"
