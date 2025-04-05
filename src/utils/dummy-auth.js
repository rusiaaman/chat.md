// Dummy auth module to replace problematic ESM imports
module.exports = {
  // Empty implementation for anything requiring auth
  createPKCEChallengePair: () => ({ code_challenge: '', code_verifier: '' }),
  authorizeUrl: () => '',
  authorizeWithClientCredentials: async () => {},
  getOAuthToken: async () => null,
  revokeToken: async () => {}
};
