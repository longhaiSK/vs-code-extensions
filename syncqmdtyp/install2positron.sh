#!/bin/zsh
# Ensure the alias works within the script
alias qmdtools='$HOME/Applications/Positron.app/Contents/Resources/app/bin/code'
setopt aliases
expand_aliases=1

# Define the Extension ID (publisher.name)
# This MUST match your package.json precisely
EXT_ID="Prof-LonghaiLi.qmd-typ-sync"

echo "Cleaning up local workspace..."
rm -f *.vsix

echo "Removing previous installation of $EXT_ID..."
# This removes the old version before we even compile the new one
qmdtools --uninstall-extension $EXT_ID || echo "No previous version found. Proceeding..."

echo "Compiling and packaging qmd-typ-sync..."
npm run compile
# Package the extension
yes | vsce package --allow-missing-repository

echo "Installing extension to Positron..."
# --force ensures it overwrites any residual files
qmdtools --install-extension *.vsix --force

echo "Done! Please restart or reload Positron."