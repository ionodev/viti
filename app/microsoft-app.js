// "Sign in with Microsoft" (to read Outlook mail): Viti's app registration in Microsoft Entra, used with the
// device flow (a public client: no secret). Register it once (free):
//   https://entra.microsoft.com → Applications → App registrations → New registration
//   name "Viti"; supported accounts: "Any Entra ID tenant + personal Microsoft accounts"; no redirect URI
//   then Authentication → "Allow public client flows": Yes
//   and API permissions → Microsoft Graph → Delegated: Mail.Read, Mail.Send, User.Read, offline_access
// and put its Application (client) ID here (it is public). VITI_MICROSOFT_CLIENT_ID overrides it.
export const MICROSOFT_CLIENT_ID = process.env.VITI_MICROSOFT_CLIENT_ID || '';

// reading now; sending (Mail.Send) is asked for too, so that adding it later needs no new approval
export const MICROSOFT_SCOPE = 'offline_access User.Read Mail.Read Mail.Send';
