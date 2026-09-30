# Google Auth + Google Contacts — Flutter/backend contract

This adds Google OAuth without replacing OmniSMS sessions. The normal OmniSMS JWT from `POST /api/auth/login` and `POST /api/auth/google/exchange` is the same token format accepted by `Authorization: Bearer …` and `GET /api/auth/me`.

## Deep links

- Google sign-in result: `omnisms://auth/google/callback?code=<one-time-code>`
- Google sign-in failure: `omnisms://auth/google/callback?error=GOOGLE_OAUTH_DENIED`
- Contacts authorization result: `omnisms://auth/google/contacts/callback?authorized=1`
- Contacts authorization refusal/error: `omnisms://auth/google/contacts/callback?error=GOOGLE_OAUTH_DENIED`

The backend returns only a short-lived, one-use exchange code to Flutter—not the OmniSMS JWT in a browser URL. Flutter exchanges the code over HTTPS, then stores the returned `token` and `user` with the existing SharedPreferences/session mechanism. These URI schemes must be registered in Android/iOS and handled by Flutter. For app-store verified App Links / Universal Links, set the two `GOOGLE_*_FLUTTER_REDIRECT_URI` variables to the deployed HTTPS links and configure association files instead.

## Google sign-in flow

1. Open `GET https://omnisms-backend.onrender.com/api/auth/google` in the system browser (no OmniSMS token required). It redirects to Google with only `openid email profile` scopes.
2. Google returns to the backend callback. The backend consumes/validates OAuth state, verifies the Google ID token and verified email, links or creates exactly one OmniSMS account, stores the OAuth subject separately from the legacy Firebase `googleUid`, and redirects to the app callback with a one-use `code`.
3. Flutter calls `POST /api/auth/google/exchange` with JSON `{ "code": "…" }`.
4. Response has the same session structure used by password login:

```json
{
  "success": true,
  "token": "<OmniSMS JWT>",
  "user": {
    "id": "<OmniSMS uid>", "name": "…", "username": null,
    "email": "…", "phone": null, "avatar": null,
    "phoneVerified": true, "isSubscribed": false,
    "credits": 0, "needsPhone": true
  }
}
```

The exchange code expires after two minutes and can only be used once. OmniSMS JWT expiry is the existing seven-day policy. `GET /api/auth/me` validates it. Existing client-side logout remains: clear the same stored OmniSMS token/user values as today.

Errors: `GOOGLE_NOT_CONFIGURED` (503), `GOOGLE_OAUTH_DENIED`, `GOOGLE_STATE_INVALID`, `GOOGLE_IDENTITY_INVALID`, `GOOGLE_IDENTITY_CONFLICT`, `GOOGLE_EXCHANGE_CODE_INVALID` (401), and `GOOGLE_EXCHANGE_FAILED`.

## Google Contacts flow (separate consent)

This is only started after the user explicitly taps “Import from Google”. Login does not request the Contacts scope.

1. With the stored OmniSMS JWT, call:

```http
POST /api/auth/google/contacts/authorize
Authorization: Bearer <OmniSMS JWT>
Content-Type: application/json
```

Empty JSON body is allowed. Response:

```json
{
  "success": true,
  "authorizationRequired": true,
  "authorizationUrl": "https://accounts.google.com/…",
  "redirectUri": "omnisms://auth/google/contacts/callback",
  "scope": "https://www.googleapis.com/auth/contacts.readonly"
}
```

2. Open `authorizationUrl` in the system browser. On approval, the Google callback stores an encrypted Google refresh token server-side and returns `authorized=1` to the app. On denial, Flutter receives `error=GOOGLE_OAUTH_DENIED`. No Google access/refresh token is sent to Flutter.
3. Flutter calls the import endpoint with the existing OmniSMS JWT:

```http
POST /api/contacts/google/import
Authorization: Bearer <OmniSMS JWT>
Content-Type: application/json
```

Empty JSON body is allowed. Success response:

```json
{
  "success": true,
  "authorizationRequired": false,
  "empty": false,
  "totalGoogleContacts": 40,
  "totalPhoneNumbers": 33,
  "imported": 25,
  "updated": 4,
  "omnismsMatches": 12,
  "external": 21,
  "skippedExisting": 4,
  "invalidNumbers": 2,
  "duplicateNumbers": 1,
  "truncated": false
}
```

New Google entries are stored in the existing `users/{uid}.contacts_synced` array with `source: "google"`; each phone number is normalized by the existing service and matched against OmniSMS users. A matching manual contact keeps its label and remains the only contact for that number. Existing VCF/synced entries are not duplicated or relabelled. Only the current user's contact arrays are written; other users' records are read-only.

Errors are JSON with stable `code`: `NO_TOKEN`/`INVALID_TOKEN` (401), `GOOGLE_CONTACTS_AUTH_REQUIRED` (409; call the authorize endpoint), `GOOGLE_TOKEN_EXPIRED` (401; repeat consent), `GOOGLE_CONTACTS_PERMISSION_REQUIRED` (403), `GOOGLE_PEOPLE_API_UNAVAILABLE` (502), `GOOGLE_ENCRYPTION_NOT_CONFIGURED` (503), `USER_NOT_FOUND` (404), or `GOOGLE_CONTACTS_IMPORT_FAILED` (500).

## Required environment

- `GOOGLE_CLIENT_ID` — Google OAuth **Web application** client ID.
- `GOOGLE_CLIENT_SECRET` — its secret; keep only in Render secrets.
- `GOOGLE_REDIRECT_URI` — exactly `https://omnisms-backend.onrender.com/api/auth/google/callback` and registered in Google Cloud Console.
- `GOOGLE_CONTACTS_REDIRECT_URI` — exactly `https://omnisms-backend.onrender.com/api/auth/google/contacts/callback` and registered in Google Cloud Console.
- `GOOGLE_FLUTTER_REDIRECT_URI` — default `omnisms://auth/google/callback`.
- `GOOGLE_CONTACTS_FLUTTER_REDIRECT_URI` — default `omnisms://auth/google/contacts/callback`.
- `GOOGLE_TOKEN_ENCRYPTION_KEY` — 32 random bytes in base64 or 64-character hex. Generate with `openssl rand -base64 32`. Keep the same key across deployments; rotating it invalidates stored Google Contacts grants.

See `GOOGLE_CLIENT_ID`, etc. in Render Environment and `.env.example`. Credentials are never logged.

## Google Cloud Console

1. Create/select a Google Cloud project and configure the OAuth consent screen, authorized app audience, branding and support email.
2. Enable **People API**.
3. Create an OAuth client of type **Web application**. Add both exact backend redirect URIs listed below under **Authorized redirect URIs**. This implementation does not use the Google JavaScript SDK, so **Authorized JavaScript origins can remain empty**; only add a browser origin there if a separate web frontend later calls Google directly from JavaScript. Add the production app/backend domains to authorized domains as required by the consent-screen configuration.
Authorized redirect URIs:

```text
https://omnisms-backend.onrender.com/api/auth/google/callback
https://omnisms-backend.onrender.com/api/auth/google/contacts/callback
```

For **Authorized JavaScript origins**, leave the field empty for the Flutter/backend-server OAuth flow documented here. Do not enter the Flutter custom scheme (`omnisms://`) as an origin or redirect URI; it is only the app return link after the backend callback.

4. Request only `openid`, `email`, `profile` at login. Request `https://www.googleapis.com/auth/contacts.readonly` only in the separate contacts flow. If Google requires verification for this scope/audience, complete that verification before production use.
5. Add the client ID/secret and encryption key to Render, then deploy.

## Flutter implementation checklist

- Register both `omnisms://` callback paths with the Flutter deep-link plugin and native Android/iOS app configuration.
- Launch `/api/auth/google` in an external/system browser. On the login deep link, extract `code`, POST it to `/api/auth/google/exchange`, and store the returned OmniSMS `token` and `user` exactly as the current email/password flow does.
- Only on the import button, POST `/api/auth/google/contacts/authorize` with the current Bearer JWT, launch `authorizationUrl`, and await the contacts callback deep link.
- If `authorized=1`, POST `/api/contacts/google/import` with the same Bearer JWT and display counts. If denied, show a non-blocking denial message and do not call import. If `GOOGLE_CONTACTS_AUTH_REQUIRED`/`GOOGLE_TOKEN_EXPIRED`, offer the authorization step again.
- Do not persist or forward Google tokens; only the normal OmniSMS JWT belongs in SharedPreferences.
