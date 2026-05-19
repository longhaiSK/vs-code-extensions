#!/bin/zsh
# Ensure the alias works within the script
alias qmdtools=$workide
setopt aliases
expand_aliases=1

# Define the Extension ID (publisher.name)
EXT_ID="Prof-LonghaiLi.qmd2typ-pro"

# 1. Extract the current version directly from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Building version: $CURRENT_VERSION"

# 2. Clean up old .vsix files from the local directory
echo "Cleaning up local workspace..."
for file in *.vsix(N); do
    if [[ "$file" != *"$CURRENT_VERSION"* ]]; then
        echo " -> Deleting old installer: $file"
        rm -f "$file"
    fi
done

# 3. Uninstall the extension from Positron
echo "Uninstalling existing extension from Positron..."
qmdtools --uninstall-extension $EXT_ID || echo "No previous version found in Positron. Proceeding..."

# 4. Compile and Package
echo "Compiling and packaging qmd-typ-sync..."
npm run compile
yes | vsce package --allow-missing-repository

# 5. Install the newly created extension
echo "Installing extension to Positron..."
# By explicitly using the CURRENT_VERSION variable in the glob, 
# we guarantee we only install the newly built file.
qmdtools --install-extension *${CURRENT_VERSION}.vsix --force
