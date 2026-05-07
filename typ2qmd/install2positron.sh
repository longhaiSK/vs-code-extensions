#!/bin/zsh

# 1. Compile the TypeScript
npm run compile

# 2. Package into VSIX without prompts
vsce package --allow-missing-repository 

# 3. Optional: Install directly to Positron if 'positron' is in your PATH
workon --install-extension *.vsix --force
