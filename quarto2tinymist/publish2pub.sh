
CURRENT_VERSION=$(node -p "require('./package.json').version")

# 6. Upload to GitHub Release
echo "Uploading to GitHub Release (v$CURRENT_VERSION)..."
VSIX_FILE=$(ls *${CURRENT_VERSION}.vsix | head -n 1)

if [[ -f "$VSIX_FILE" ]]; then
    # Create the release if it doesn't exist yet (silences the error if it fails to find one, then creates it)
    gh release view "v$CURRENT_VERSION" >/dev/null 2>&1 || \
        gh release create "v$CURRENT_VERSION" --title "v$CURRENT_VERSION" --generate-notes
    
    # Upload the binary only if the release doesn't already have an asset with this name
    if gh release view "v$CURRENT_VERSION" --json assets -q '.assets[].name' | grep -qxF "$VSIX_FILE"; then
        echo " -> $VSIX_FILE already attached to GitHub Release, skipping."
    else
        gh release upload "v$CURRENT_VERSION" "$VSIX_FILE"
        echo " -> Uploaded $VSIX_FILE to GitHub Release successfully!"
    fi
else
    echo " -> Warning: .vsix file not found, skipping GitHub upload."
fi

# # 7. Publish to VS Code Marketplace
# echo "Publishing to VS Code Marketplace..."
# if ! command -v vsce &> /dev/null; then
#     echo " -> Warning: 'vsce' CLI not found. Install with: npm install -g @vscode/vsce"
# elif [[ -z "$VSCE_PAT" ]]; then
#     echo " -> Warning: VSCE_PAT environment variable not set. Skipping VS Code Marketplace."
# else
#     # -i uses the already-built vsix; --skip-duplicate tolerates re-runs of the same version
#     vsce publish -i "$VSIX_FILE" -p "$VSCE_PAT" --skip-duplicate
#     echo " -> Published successfully to VS Code Marketplace!"
# fi

# 8. Publish to Open VSX Registry (Positron/VSCodium)
echo "Publishing to Open VSX Registry..."
if ! command -v ovsx &> /dev/null; then
    echo " -> Warning: 'ovsx' CLI not found. Install with: npm install -g ovsx"
elif [[ -z "$OVSX_PAT" ]]; then
    echo " -> Warning: OVSX_PAT environment variable not set. Skipping Open VSX."
else
    # ovsx publish uses the built vsix file and the token
    ovsx publish "$VSIX_FILE" -p "$OVSX_PAT" --skip-duplicate
    echo " -> Published successfully to Open VSX Registry!"
fi

echo "Done! Please restart or reload Positron."
