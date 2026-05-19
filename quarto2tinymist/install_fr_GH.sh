#!/bin/bash

# Exit immediately if any command fails
set -e

# Configuration
USER="longhaiSK"
# Updated with underscores to match your exact GitHub repository name
REPO="vs-code-extensions" 
QMDTOOLS=$workide

echo "Checking for Positron binary..."
if [ ! -f "$QMDTOOLS" ]; then
    echo "Error: Positron binary not found at:"
    echo "  $QMDTOOLS"
    echo "Please check if Positron is installed in your Applications folder."
    exit 1
fi

echo "Fetching the latest release metadata from GitHub..."
# Now successfully queries: https://api.github.com/repos/longhaiSK/vs_code_extensions/releases/latest
RELEASE_JSON=$(curl -s "https://api.github.com/repos/$USER/$REPO/releases/latest")

# Extract the browser download URL for the .vsix file
VSIX_URL=$(echo "$RELEASE_JSON" | grep -o 'https://github.com/[^"]*\.vsix' | head -n 1)

if [ -z "$VSIX_URL" ]; then
    echo "Error: Could not find a .vsix file attached to the latest GitHub release."
    echo "Verify that the file asset is attached to your release on GitHub."
    exit 1
fi

# Extract the filename from the URL (resolves to qmd2typ-pro-2.1.1.vsix)
FILENAME=$(basename "$VSIX_URL")

echo "Downloading $FILENAME..."
curl -L -o "$FILENAME" "$VSIX_URL"

echo "Installing extension to Positron..."
"$QMDTOOLS" --install-extension "$FILENAME"

echo "Cleaning up temporary files..."
rm "$FILENAME"

echo "Success! The extension has been installed smoothly."