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

// Create a custom plugin to properly handle ESM/CJS interoperability
const esmCompatPlugin = {
  name: 'esm-compat',
  setup(build) {
    // Filter for problematic ESM modules
    build.onResolve({ filter: /pkce-challenge|@modelcontextprotocol\/sdk\/.*\/auth/ }, args => {
      // Return a dummy path for problematic packages
      if (args.path.includes('pkce-challenge') || args.path.includes('auth')) {
        return { 
          path: require.resolve('./src/utils/dummy-auth.js'),
          external: false
        };
      }
      return null;
    });
  }
};

// Plugin to optimize imports and reduce bundle size
const optimizationPlugin = {
  name: 'optimization',
  setup(build) {
    // Mark some large dependencies as external if they're not critical
    // This requires them to be available in the runtime environment
    
    // We could potentially externalize zod if it's not critical for core functionality
    // but this might break MCP functionality, so we'll keep it bundled for now
  }
};

// Create a dummy auth.js file if it doesn't exist
const dummyAuthDir = path.join(__dirname, 'src', 'utils');
const dummyAuthPath = path.join(dummyAuthDir, 'dummy-auth.js');

if (!fs.existsSync(dummyAuthPath)) {
  if (!fs.existsSync(dummyAuthDir)) {
    fs.mkdirSync(dummyAuthDir, { recursive: true });
  }
  fs.writeFileSync(dummyAuthPath, `
// Dummy auth module to replace problematic ESM imports
module.exports = {
  // Empty implementation for anything requiring auth
  createPKCEChallengePair: () => ({ code_challenge: '', code_verifier: '' }),
  authorizeUrl: () => '',
  authorizeWithClientCredentials: async () => {},
  getOAuthToken: async () => null,
  revokeToken: async () => {}
};
  `);
}

async function build() {
  try {
    const ctx = await esbuild.context({
      entryPoints: ['./src/extension.ts'],
      bundle: true,
      outfile: './dist/extension.js',
      external: [
        'vscode', // Always external for VS Code extensions
        // Potentially external dependencies (but be careful):
        // 'zod', // Would require zod to be available at runtime
      ],
      format: 'cjs',
      platform: 'node',
      minify: production,
      sourcemap: !production,
      metafile: true,
      logLevel: 'info',
      target: 'node14',
      resolveExtensions: ['.ts', '.js', '.json', '.node'],
      plugins: [esmCompatPlugin, optimizationPlugin],
      define: {
        'process.env.NODE_ENV': production ? '"production"' : '"development"'
      },
      // Tree shaking optimizations
      treeShaking: true,
      // Split large modules
      splitting: false, // VS Code extensions don't support code splitting
      // Optimize for size in production
      ...(production && {
        mangleProps: /^_/,  // Mangle private properties
        drop: ['console', 'debugger'], // Remove console logs and debugger statements
      }),
    });

    if (watch) {
      console.log('Watching for changes...');
      await ctx.watch();
    } else {
      const result = await ctx.rebuild();
      
      // Show bundle analysis
      if (result.metafile) {
        console.log('\n=== OPTIMIZED BUNDLE ANALYSIS ===');
        const outputs = result.metafile.outputs;
        for (const [file, info] of Object.entries(outputs)) {
          const sizeKB = (info.bytes / 1024).toFixed(2);
          console.log(`📦 ${file}: ${sizeKB} KB`);
        }
      }
      
      await ctx.dispose();
      console.log('Optimized build complete');
    }
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}

build();
