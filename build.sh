#!/bin/bash
set -e

# Build script for filechat VS Code extension

echo "Building filechat VS Code extension..."

# Clean build
echo "Cleaning previous build artifacts..."
rm -rf dist out *.vsix

# Compile TypeScript
echo "Compiling TypeScript..."
npm run compile

# Install vsce if not already installed
if ! command -v vsce &> /dev/null; then
    echo "Installing vsce..."
    npm install -g @vscode/vsce
fi

# Create VSIX package
echo "Creating VSIX package..."
vsce package

echo "Build complete!"
echo "VSIX package created:"
ls -la *.vsix
