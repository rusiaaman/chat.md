const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

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

async function analyzeBundleSize() {
  try {
    const result = await esbuild.build({
      entryPoints: ['./src/extension.ts'],
      bundle: true,
      outfile: './dist/extension-analyze.js',
      external: ['vscode'],
      format: 'cjs',
      platform: 'node',
      minify: false,
      sourcemap: false,
      metafile: true,
      logLevel: 'info',
      target: 'node14',
      resolveExtensions: ['.ts', '.js', '.json', '.node'],
      plugins: [esmCompatPlugin],
      define: {
        'process.env.NODE_ENV': '"development"'
      },
    });

    // Write metafile for analysis
    fs.writeFileSync('meta.json', JSON.stringify(result.metafile));
    console.log('\n=== BUNDLE SIZE ANALYSIS ===');
    
    // Analyze the outputs
    const outputs = result.metafile.outputs;
    for (const [file, info] of Object.entries(outputs)) {
      const sizeKB = (info.bytes / 1024).toFixed(2);
      console.log(`📦 ${file}: ${sizeKB} KB`);
    }

    // Analyze the inputs by size
    console.log('\n=== LARGEST DEPENDENCIES ===');
    const inputs = result.metafile.inputs;
    const sortedInputs = Object.entries(inputs)
      .map(([file, info]) => ({ file, bytes: info.bytes }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 15); // Top 15 largest files

    sortedInputs.forEach(({ file, bytes }) => {
      const sizeKB = (bytes / 1024).toFixed(2);
      console.log(`  ${sizeKB} KB - ${file}`);
    });

    // Analyze by package
    console.log('\n=== BY PACKAGE ===');
    const packageSizes = {};
    Object.entries(inputs).forEach(([file, info]) => {
      if (file.includes('node_modules')) {
        const match = file.match(/node_modules\/([^\/]+)/);
        if (match) {
          const packageName = match[1];
          packageSizes[packageName] = (packageSizes[packageName] || 0) + info.bytes;
        }
      } else {
        packageSizes['src (your code)'] = (packageSizes['src (your code)'] || 0) + info.bytes;
      }
    });

    const sortedPackages = Object.entries(packageSizes)
      .sort(([,a], [,b]) => b - a);

    sortedPackages.forEach(([pkg, bytes]) => {
      const sizeKB = (bytes / 1024).toFixed(2);
      console.log(`  ${sizeKB} KB - ${pkg}`);
    });

    console.log('\n✅ Analysis complete! Check meta.json for detailed analysis.');
    console.log('💡 You can use https://esbuild.github.io/analyze/ to visualize meta.json');

  } catch (error) {
    console.error('❌ Analysis failed:', error);
    process.exit(1);
  }
}

analyzeBundleSize();
