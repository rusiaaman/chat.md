#!/bin/bash

# Install dependencies
npm install

# Create dist directory if it doesn't exist
mkdir -p dist

# Compile TypeScript
echo "Compiling TypeScript..."
npx tsc -p ./

echo "Build complete!"
echo "To run/debug the extension in VSCode:"
echo "1. Open this folder in VSCode"
echo "2. Press F5 to start debugging"
echo "3. Create or open a .chat.md file"
echo "4. Configure your Anthropic API key using the command palette"
