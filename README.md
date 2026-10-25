# ASCENT — scent releaser controller

A local web app that controls 4 Sonoff-relay scent releasers through your eWeLink
account, with a minimal pastel-green UI: a Scents tab (press to release, mix
freely), a Timeline tab (drop scent cues on a video like clips in an editor,
playback fires the relays), and a Settings tab.

This version logs into eWeLink with **OAuth** (the App ID/App Secret + a
browser login), which is the only app type eWeLink now issues on the free
"Standard Role" tier — that's why the App Type field in the dev console is
locked to `OAuth2.0`. That's expected and correct for this use case; you don't
need a paid/premium account.

## 1. Create your eWeLink app

1. Go to https://dev.ewelink.cc/, log in, and apply as an **Individual
   Developer** if you haven't already (usually approved within a day).
2. Console → Create App:
   - **App Type**: `OAuth2.0` (only option — that's fine)
   - **App Role**: `Standard Role`
   - **Redirect URL**: `http://<this-computer's-LAN-IP>:4321/auth/callback`
     — e.g. `http://10.9.137.250:4321/auth/callback`. Use the machine's
     actual LAN IP (not `localhost`) if you'll open the page from your phone
     too. This must match **exactly**, including the path, what you put in
     the app's Settings tab.
3. Copy the **App ID** and **App Secret** it gives you.

## 2. Run the server

```
npm install
npm start
```

Then open `http://localhost:4321` (or `http://<LAN-IP>:4321` from another
device on your network).

## 3. Connect your account

1. Put your App ID and App Secret in `data/secrets.json`, then set the same
  Redirect URL you registered in the Settings tab and click **Save**.
2. Click **Connect eWeLink account** — this opens eWeLink's login page in
   your browser. Log in and approve. You'll be bounced back to ASCENT
   automatically once it's connected (green dot, top right).
3. Click **Fetch devices** — this lists the devices on your account so you
   can assign one to each scent from a dropdown, instead of typing device
   IDs by hand.
4. For each scent, set:
   - **Device** — pick your Sonoff from the list (or paste its device ID if
     "Fetch devices" doesn't show it).
   - **Outlet** — `0`–`3` if you're using one 4-channel Sonoff for all four
     scents. If you're using four separate single-relay Sonoffs instead,
     assign a different device to each scent and leave outlet at `0`.
   - **Pulse (ms)** — how long the relay stays on when you press the
     button, e.g. `3000` for a 3-second puff.

## 4. Use it

- **Scents tab** — four buttons, each pulses its relay for the configured
  duration. Press more than one to mix.
- **Timeline tab** — upload a video, click a track under the ruler to drop a
  scent cue at the playhead, drag cues to retime them, double-click a cue to
  remove it. Hit play and the matching relay fires as the playhead crosses
  each cue. **Save timeline** persists cues per video (stored in
  `data/timelines/`).

## Notes

- Access tokens last ~30 days; if the dot turns grey, just reconnect from
  Settings.
- App credentials and OAuth tokens are stored in the ignored
  `data/secrets.json` file. Do not commit that file or expose this app to the
  internet as-is.
- If eWeLink's login page says the redirect URL doesn't match, double-check
  it's character-for-character identical between the dev console and the
  Settings tab (including `http://` vs `https://` and any trailing slash).
