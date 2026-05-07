#!/bin/zsh
# Ensure the alias works within the script
alias qmdtools='$HOME/Applications/Positron.app/Contents/Resources/app/bin/code'
expand_aliases=1

echo "Cleaning up old builds..."
rm -f *.vsix

echo "Compiling and packaging qmd-typ-sync..."
npm run compile
# Package the extension (produces qmd-typ-sync-0.1.0.vsix)
yes | vsce package --allow-missing-repository

echo "Installing extension to Positron..."
# Explicitly target the new name to avoid any ambiguity
qmdtools --install-extension qmd-typ-sync-*.vsix --force

#echo "Cleanup..."
#rm qmd-typ-sync-*.vsix

echo "Done! Please restart or reload Positron."