# OAuth2 Setup Instructions

This guide walks you through setting up OAuth2 credentials for gdoc CLI.

## Prerequisites

- Google account (your personal or work account)
- Access to Google Cloud Console

## Step-by-Step Setup

### 1. Go to Google Cloud Console

Open: https://console.cloud.google.com

### 2. Create or Select a Project

- If you don't have a project, click **Create Project**
  - Name: anything you like (e.g., "gdoc-cli" or "personal-tools")
  - Location: leave as default
  - Click **CREATE**

- If you have an existing project, select it from the dropdown at the top

### 3. Enable Google Docs API

1. Go to: **APIs & Services** → **Library** (or click [here](https://console.cloud.google.com/apis/library))
2. Search for: `Google Docs API`
3. Click on **Google Docs API**
4. Click **ENABLE** (if not already enabled)

### 4. Configure OAuth Consent Screen

1. Go to: **APIs & Services** → **OAuth consent screen** (or click [here](https://console.cloud.google.com/apis/credentials/consent))

2. Choose user type:
   - **Internal**: If using Google Workspace (company account) - only users in your org can use it
   - **External**: If using personal Google account - anyone can use it (but still requires approval for each user)

3. Click **CREATE**

4. Fill in OAuth consent screen:
   - **App name**: `gdoc CLI` (or any name you prefer)
   - **User support email**: (select your email)
   - **Developer contact email**: (your email)
   - Leave other fields blank for now
   - Click **SAVE AND CONTINUE**

5. **Scopes**: Click **SAVE AND CONTINUE** (skip this step)

6. **Test users** (only if you chose "External"):
   - Click **+ ADD USERS**
   - Add your email address
   - Click **SAVE AND CONTINUE**

7. **Summary**: Click **BACK TO DASHBOARD**

### 5. Create OAuth2 Credentials

1. Go to: **APIs & Services** → **Credentials** (or click [here](https://console.cloud.google.com/apis/credentials))

2. Click: **+ CREATE CREDENTIALS** → **OAuth client ID**

3. Configure the OAuth client:
   - **Application type**: Select **Desktop app**
   - **Name**: `gdoc CLI` (or any name you prefer)
   - Click **CREATE**

4. A popup appears showing your client ID and secret
   - Click **DOWNLOAD JSON** button
   - Or click the download icon (⬇) next to your credential in the list

### 6. Install the Credentials

1. The downloaded file will be named something like:
   ```
   client_secret_xxxxx-yyyyy.apps.googleusercontent.com.json
   ```

2. Move it to the gdoc auth directory:
   ```bash
   mkdir -p ~/.gdoc
   mv ~/Downloads/client_secret_*.json ~/.gdoc/credentials.json
   ```

### 7. Add Redirect URI

**Important**: You must add the redirect URI for the local server to work.

1. Go back to: **APIs & Services** → **Credentials**

2. Find your OAuth2 credential (e.g., "gdoc CLI") and click the **edit icon** (pencil)

3. Scroll down to **Authorized redirect URIs**

4. Click **+ ADD URI**

5. Enter: `http://localhost:3000`

6. Click **SAVE**

### 8. Authenticate

Now you're ready to authenticate:

```bash
gdoc auth
```

**What happens:**
1. Browser opens automatically to Google's auth page
2. Sign in with your Google account
3. Click **Allow** to grant access
4. Browser shows: "You can now safely close this window and return to the terminal."
5. Terminal shows: "✓ Authentication complete!"

Your authentication token is saved in `~/.gdoc/token.json` and will be reused for future commands.

## Troubleshooting

### "Error: redirect_uri_mismatch"

This means you forgot to add `http://localhost:3000` to **Authorized redirect URIs** in step 7.

**Fix:**
1. Go to Google Cloud Console → Credentials
2. Edit your OAuth2 credential
3. Add `http://localhost:3000` to Authorized redirect URIs
4. Save and try `gdoc auth` again

### "Access blocked: This app's request is invalid"

This can happen if:
1. You didn't enable Google Docs API (step 3)
2. OAuth consent screen isn't configured (step 4)

**Fix:**
1. Verify Google Docs API is enabled
2. Verify OAuth consent screen is configured
3. Try `gdoc auth` again

### "Authentication timeout"

The local server waits 5 minutes for you to complete authentication.

**Fix:**
- Run `gdoc auth` again
- Make sure you click "Allow" within 5 minutes

### Token expired or invalid

Tokens typically last a long time (months), but can expire or be revoked.

**Fix:**
```bash
gdoc auth
```

This will remove the old token and get a new one.

## Security Notes

- **`.gdoc/credentials.json`**: Contains your app's client ID and secret. Keep it private but it's not super sensitive.
- **`.gdoc/token.json`**: Contains your personal access token. This IS sensitive - anyone with this file can access your Google Docs as you.
- The entire `.gdoc/` directory is in `.gitignore` to prevent accidental commits.

## For Organizations (Google Workspace)

If you're setting this up for an organization:

1. Use **Internal** user type in OAuth consent screen
2. No need to add test users - all org members can authenticate
3. Consider creating a shared project that multiple team members can use
4. Each user still needs to run `gdoc auth` to get their own token

## Additional Resources

- [Google OAuth2 Documentation](https://developers.google.com/identity/protocols/oauth2)
- [Google Docs API Reference](https://developers.google.com/docs/api)
