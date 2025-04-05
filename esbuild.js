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
        'vscode', // Only exclude vscode, include everything else
      ],
      format: 'cjs',
      platform: 'node',
      minify: production,
      sourcemap: !production,
      metafile: true,
      logLevel: 'info',
      target: 'node14',
      resolveExtensions: ['.ts', '.js', '.json', '.node'],
      plugins: [esmCompatPlugin],
      define: {
        'process.env.NODE_ENV': production ? '"production"' : '"development"'
      },
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