// "Sign in with GitHub": Viti's OAuth App on GitHub, used with the device flow (no secret is needed, so it
// is safe to ship in the app). Register it once:
//   GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
//   name "Viti", homepage and callback URL: the project's page (the callback is not used)
//   then tick "Enable Device Flow", and put its Client ID here (it is public).
// VITI_GITHUB_CLIENT_ID in the environment overrides it (for trying another app).
export const GITHUB_CLIENT_ID = process.env.VITI_GITHUB_CLIENT_ID || 'Ov23lihG7PeySSgXE9fk';

// what Viti asks for: the repositories you can see, to read their branches and write its backup branch
export const SCOPE = 'repo';
