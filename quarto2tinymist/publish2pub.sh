
CURRENT_VERSION=$(node -p "require('./package.json').version")

# 6. Upload to GitHub Release
echo "Uploading to GitHub Release (v$CURRENT_VERSION)..."
VSIX_FILE=$(ls *${CURRENT_VERSION}.vsix | head -n 1)

if [[ -f "$VSIX_FILE" ]]; then
    # Create the release if it doesn't exist yet (silences the error if it fails to find one, then creates it)
    gh release view "v$CURRENT_VERSION" >/dev/null 2>&1 || \
        gh release create "v$CURRENT_VERSION" --title "v$CURRENT_VERSION" --generate-notes
    
    # Upload the binary, replacing any existing asset with the same name
    gh release upload "v$CURRENT_VERSION" "$VSIX_FILE" --clobber
    echo " -> Uploaded $VSIX_FILE to GitHub Release successfully!"
else
    echo " -> Warning: .vsix file not found, skipping GitHub upload."
fi

echo "Done! Please restart or reload Positron."

# # 7. Publish to VS Code Marketplace
# echo "Publishing to VS Code Marketplace..."
# if [[ -z "$VSCE_PAT" ]]; then
#     echo " -> Warning: VSCE_PAT environment variable not set. Skipping VS Code Marketplace."
# else
#     # The -i flag tells vsce to use the already-built vsix file
#     # The -p flag passes the token securely
#     vsce publish -i "$VSIX_FILE" -p "$VSCE_PAT"
#     echo " -> Published successfully to VS Code Marketplace!"
# fi

# # 8. Publish to Open VSX Registry (Positron/VSCodium)
# echo "Publishing to Open VSX Registry..."
# if ! command -v ovsx &> /dev/null; then
#     echo " -> Warning: 'ovsx' CLI not found. Install with: npm install -g ovsx"
# elif [[ -z "$OVSX_PAT" ]]; then
#     echo " -> Warning: OVSX_PAT environment variable not set. Skipping Open VSX."
# else
#     # ovsx publish uses the built vsix file and the token
#     ovsx publish "$VSIX_FILE" -p "$OVSX_PAT"
#     echo " -> Published successfully to Open VSX Registry!"
# fi
