# GSRP CAD

Computer aided dispatch for the Georgia State Roleplay ER:LC server. One free Cloudflare Worker serves the app and keeps everything shared: logins, units on duty, calls, radio traffic, civilians and rosters. It installs on phones and PCs like an app.

## What works

- Tablet-style sign in with badge number and PIN. Admins create logins; each member picks their own PIN at first sign in. PINs are stored hashed, and five wrong tries lock a badge for five minutes.
- "Log in with Discord" (optional). The CAD reads the member's roles in your main server and unlocks the matching departments.
- Six departments: Sheriff, State Patrol, Police, Fire, EMS and DOT, each with its own ranks, call types, radio channel and quick button.
- Live updates. Calls, unit status, panic and radio traffic reach everyone within a second.
- Text radio with six channels, push to talk on F (speech to text in Chrome and Edge), and an optional read-aloud voice.
- Scripted dispatcher on the radio, with a switch for the CAD and a separate switch for Discord (posts through a channel webhook).
- Civilian portal: characters, licence cards and vehicles that officers can run.
- Rosters by department and rank, updated the moment a login is created.

## What is not built yet

- Real voice audio on the CAD radio. The radio is text, with speech to text and read-aloud.
- AI on the CAD radio. That dispatcher is scripted. The AI dispatcher lives in Discord voice instead (see below).
- Live data from the ER:LC server (players, vehicles, in-game commands).
- Live map and bodycam.

## Put it online (free)

You need a GitHub account (this repo) and a free Cloudflare account. Menu names on Cloudflare can change, so look for the closest match.

1. Sign up at cloudflare.com and open the dashboard.
2. Go to Workers & Pages, choose Create, then import a Git repository. Connect GitHub and pick this repo.
3. Leave the build command empty. The deploy command is `npx wrangler deploy`. Press Deploy.
4. When it finishes you get a link ending in `workers.dev`. Open it.
5. **Do this straight away:** the first screen asks you to create the owner login. Whoever fills it in first becomes the admin, so do it before sharing the link.

Every push to this repo redeploys the site. Your data stays.

## Turn on Discord login and roles

1. Go to discord.com/developers/applications and create an application.
2. Open OAuth2. Copy the Client ID and Client Secret.
3. In the CAD, open Admin, then Discord. Copy the redirect link shown there and add it under Redirects in the Discord application.
4. In Discord, turn on Developer Mode (User Settings, Advanced). Right-click your server and copy its ID. Right-click each department role and copy its ID.
5. Paste the IDs into the CAD's Discord tab and save.

Members then press "Log in with Discord", enter their badge and PIN once to link, and their departments follow their Discord roles from then on. Roles refresh each time they log in with Discord.

## Dispatch in Discord

1. In the Discord channel you want, open Edit Channel, Integrations, Webhooks, and create a webhook. Copy its link.
2. Paste it in the CAD under Admin, Discord, and save.
3. Under Admin, Dispatch, turn the Discord switch on.

Radio traffic, 911 calls and panic alerts are then posted in that channel. This is one-way: the CAD posts to Discord. It does not listen to Discord voice.

## AI dispatch in a Discord voice channel

The `voice-bot` folder holds a separate bot that joins a voice channel, wakes on "dispatch", answers out loud with a free AI model, and updates the CAD. It runs on your own PC during sessions. Setup steps are in `voice-bot/README.md`. It has not been run against Discord yet.

## Install as an app

- iPhone: open the link in Safari, tap Share, then Add to Home Screen.
- Android: open the link in Chrome, open the menu, then Install app.
- PC: open the link in Chrome or Edge and press the install icon in the address bar.

## Free plan limits

Cloudflare's free plan allows 100,000 server requests a day. Each button press is one request and live updates do not count much, so a single roleplay server fits. If the limit is hit, the CAD stops responding until midnight UTC.

## For developers

- `src/worker.js`: the Worker and the `Cad` Durable Object (all server logic).
- `public/`: the app (`index.html`, `app.js`, `styles.css`), manifest, service worker and icons.
- `npm test` runs the server smoke test, the app screen test and the bot helper test. None of them need Cloudflare or Discord.
- `voice-bot/`: the Discord voice dispatcher. Cloudflare ignores this folder.
- Department names, ranks and radio channels are listed at the top of both `src/worker.js` and `public/app.js`. Keep the two in step.
