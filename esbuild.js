const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

// Clean dist directory first
if (fs.existsSync('dist')) {
  console.log('Cleaning dist directory...');
  const files = fs.readdirSync('dist');
  for (const file of files) {
    if (file !== 'extension.js' && file !== 'extension.js.map') {
      const filePath = path.join('dist', file);
      try {
        if (fs.lstatSync(filePath).isDirectory()) {
          // Skip directories for now
        } else {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        console.error(`Failed to delete ${filePath}:`, err);
      }
    }
  }
}

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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
    const ctx = await esbuild.context({
      entryPoints: ['./src/extension.ts'],
      bundle: true,
      outfile: './dist/extension.js',
      external: ['vscode'], // Only exclude vscode, include everything else
      format: 'cjs',
      platform: 'node',
      minify: production,
      sourcemap: !production,
      metafile: true,
      logLevel: 'info',
    });

    if (watch) {
      console.log('Watching for changes...');
      await ctx.watch();
    } else {
      await ctx.rebuild();
      await ctx.dispose();
      console.log('Build complete');
    }
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}

build();
