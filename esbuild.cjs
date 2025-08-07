const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

// Clean dist directory first
const distDir = 'dist';
if (fs.existsSync(distDir)) {
  console.log('Cleaning dist directory...');
  fs.rmSync(distDir, { recursive: true, force: true });
}
fs.mkdirSync(distDir);

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Content for the CJS wrapper file
const cjsWrapperContent = `// This file acts as a CommonJS entry point for VS Code.
// It uses dynamic import() to load the actual ES Module extension code.

async function activate(context) {
  try {
    const mod = await import('./extension.js');
    if (mod.activate) {
       console.log('chat.md: Activating ES Module...');
       return await mod.activate(context);
    } else {
       console.error('chat.md: ES Module does not export an activate function.');
       throw new Error('ES Module activate function not found.');
    }
  } catch (err) {
    console.error('chat.md: Failed to dynamically import or activate ES module:', err);
    // Propagate the error to VS Code for logging/reporting
    throw err;
  }
}

async function deactivate() {
  try {
    const mod = await import('./extension.js');
    if (mod.deactivate) {
       console.log('chat.md: Deactivating ES Module...');
       return await mod.deactivate();
    }
  } catch (err) {
     console.error('chat.md: Failed to dynamically import or deactivate ES module:', err);
     // Optionally handle errors during deactivation, though often less critical
     // throw err; // Or just log
  }
}

module.exports = {
  activate,
  deactivate
};
`;


const watchConfig = watch ? {
  onRebuild(error, result) {
    if (error) {
      console.error('Watch build failed:', error);
    } else {
      console.log('Watch build succeeded');
    }
  },
} : false;

async function build() {
  try {
    // Build the main ESM module
    const esmConfig = {
      entryPoints: ['./src/extension.ts'],
      bundle: true,
      outfile: './dist/extension.js',
      external: ['vscode'], // Keep vscode external
      format: 'esm', // Output ES Module
      platform: 'node',
      target: 'node16', // Target Node version that supports ESM and top-level await
      minify: production,
      sourcemap: !production,
      logLevel: 'info',
    };

    if (watch) {
      console.log('Watching for changes (ESM)...');
      const ctx = await esbuild.context(esmConfig);
      // In watch mode, we might skip writing the CJS wrapper on each rebuild
      // or regenerate it if needed. For simplicity, just build ESM.
      await ctx.watch(watchConfig);
      // Note: CJS wrapper won't auto-update in watch mode with this setup.
    } else {
      console.log('Building extension (ESM)...');
      await esbuild.build(esmConfig);
      console.log('ESM build complete.');

      // --- Create the CJS wrapper file ---
      const wrapperPath = path.join(__dirname, 'dist', 'extension.cjs');
      try {
        fs.writeFileSync(wrapperPath, cjsWrapperContent);
        console.log(`Created CJS wrapper: ${wrapperPath}`);
      } catch (writeErr) {
        console.error(`Failed to write CJS wrapper: ${writeErr}`);
        throw writeErr; // Fail the build if wrapper can't be created
      }
      // --- End wrapper creation ---
      console.log('Build process finished.');
    }
  } catch (err) {
    console.error('Build process failed:', err);
    process.exit(1);
  }
}

build();
