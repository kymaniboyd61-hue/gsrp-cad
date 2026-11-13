# GSRP voice dispatch bot

An AI dispatcher that sits in one Discord voice channel. Say "dispatch" and it answers out loud. It is connected to the CAD, so it can run plates and names, change your status, and create, give out and clear calls. What it hears and says also shows as text on the CAD radio.

It runs on your own PC while a session is on. Close the window and it leaves.

## Honest status

The CAD side of this bot is tested. The bot itself has not been run against Discord yet, so expect to fix a thing or two on first start. Two known risks:

- Discord does not officially support bots listening in voice channels. The library this bot uses does it anyway, and it has had problems since Discord encrypted all calls in 2026. If the bot joins but never hears anyone, that is the likely cause.
- The free speech and AI service (Groq) has daily limits: about 2,000 voice clips and 1,000 AI answers a day at the time of writing. Every time someone talks in the channel, one clip is used, even without the wake word. A very busy channel can run out.

## What you need

1. **Node.js 22.12 or newer** from nodejs.org (the LTS installer).
2. **A Discord bot token.** In the Discord Developer Portal, open your application, go to Bot, and press Reset Token. Copy it.
3. **The bot in your server.** In the same application, go to OAuth2, URL Generator, tick `bot`, then tick the View Channels, Connect and Speak permissions. Open the link it makes and add the bot to your main server.
4. **A free Groq key** from console.groq.com, under API Keys. No card needed.
5. **A CAD bot key.** In the CAD, open Admin, then Discord, and press Create bot key. It is shown once.

## Set it up

1. Download this repo (green Code button on GitHub, then Download ZIP) and unzip it.
2. Open the `voice-bot` folder.
3. Copy `.env.example`, name the copy `.env`, and fill in every line. Channel and server IDs come from right-clicking them in Discord with Developer Mode on.
4. Double-click `start.bat`. The first start installs what it needs, which takes a minute.

When it says it is in the voice channel, it is ready.

## Turn it on and off

In the CAD, open Admin, then Dispatch. The **Discord** switch controls this bot. Off means it stays in the channel but ignores everyone. The CAD radio switch is separate.

## Using it

- "Dispatch, show me 10-8."
- "Dispatch, run plate ABC123."
- "Dispatch, I'm on a traffic stop at postal 214."
- "Dispatch, any calls holding?"
- "Dispatch." It answers "Go ahead", then listens to your next sentence.
- You can also ask it ordinary questions.

For status and call changes, the bot has to know which unit is speaking. Each member must press "Log in with Discord" on the CAD once and link their badge, and be on duty. Anyone else still gets answers, but the bot cannot change the CAD for them.

## If something goes wrong

- **"Missing settings in the .env file"**: a line in `.env` is empty.
- **"Discord refused the bot token"**: reset the token in the Developer Portal and paste the new one.
- **"The CAD refused the bot key"**: create a new bot key in the CAD and paste it in.
- **"Groq said 4xx" naming a model**: Groq renamed a model. Put the current names in `STT_MODEL` and `CHAT_MODEL`.
- **Joins but never answers**: check the Discord switch is on in the CAD, then see the first known risk above.
- **No voice on Mac or Linux**: Windows uses its built-in voice. Mac uses `say`. Linux needs `espeak-ng` installed.
