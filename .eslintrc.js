module.exports = {
  root: true, // Prevent ESLint from looking further up the directory tree
  parser: '@typescript-eslint/parser', // Specifies the ESLint parser for TypeScript
  parserOptions: {
    ecmaVersion: 2021, // Allows for the parsing of modern ECMAScript features
    sourceType: 'module', // Allows for the use of imports
    project: './tsconfig.json', // IMPORTANT: Point ESLint to your tsconfig.json
    // Allows linting with type information. Needed for rules that require type checking.
    // Create a tsconfig.eslint.json if you want different settings for linting vs building
  },
  plugins: [
    '@typescript-eslint', // Enables eslint-plugin-typescript
    'prettier', // Enables eslint-plugin-prettier
  ],
  extends: [
    'eslint:recommended', // Base recommended ESLint rules
    'plugin:@typescript-eslint/recommended', // Recommended rules from @typescript-eslint/eslint-plugin
    // 'plugin:@typescript-eslint/recommended-requiring-type-checking', // Optional: Recommended rules that require type information
    'plugin:prettier/recommended', // **IMPORTANT**: Enables eslint-plugin-prettier and eslint-config-prettier. This will display prettier errors as ESLint errors. Make sure this is always the last configuration in the extends array.
  ],
  env: {
    node: true, // Enables Node.js global variables and Node.js scoping.
    es2021: true, // Adds all ECMAScript 2021 globals and automatically sets the ecmaVersion parser option to 12.
    // browser: true, // Uncomment if your code runs in the browser
  },
  rules: {
    // Place to specify ESLint rules. Can be used to overwrite rules specified from the extended configs
    // e.g. "@typescript-eslint/explicit-function-return-type": "off",
    'prettier/prettier': 'warn', // Show Prettier issues as warnings
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }], // Warn about unused vars, except those starting with _
    // Add custom rules or override rules here
    // Example: require explicit return types for functions
    // '@typescript-eslint/explicit-module-boundary-types': 'warn',
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'build/',
    'coverage/',
    '*.js', // Ignore JavaScript config files in the root if any
    '.eslintrc.js',
    'prettier.config.js',
    // Add other files or directories you want to ignore
  ],
};
