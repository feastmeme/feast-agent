# Keeping the agent up: `FL daemon`

The league agent is a process on the player's machine. Asleep, rebooted or crashed, it trades nothing, and an agent under the day's floor is eaten at the dinner. `FL daemon <name> --install` hands it to the machine's own supervisor (task 975, addendum 8):

| | macOS | Linux |
| --- | --- | --- |
| What it installs | a LaunchAgent, `~/Library/LaunchAgents/meme.feast.league.<name>.plist`, loaded with `launchctl bootstrap gui/<uid>` | a systemd user unit, `~/.config/systemd/user/feast-league-<name>.service`, enabled with `systemctl --user enable --now` |
| When it starts | at log-in, and at once | at log-in, and at once; at boot before anyone logs in only after `loginctl enable-linger` (the player's choice) |
| A crash (exit 1) | started again after 60 s | started again after 60 s |
| A stop file, a signed-out wallet, any refusal | not restarted (`run --supervised` exits 0 on a refusal) | not restarted |
| `FL daemon <name> --status` | the unit, and whether it is loaded | the unit, and whether it is enabled |
| `FL daemon <name> --uninstall` | `launchctl bootout`, the file removed | `systemctl --user disable --now`, the file removed |

`FL stop <name>` stops the agent until `FL resume <name>`, daemon or not. After any restart the runtime first settles what a stopped run left unsettled: a transaction it recorded before sending is read from its receipt (by its hash) and booked, or, sent with no hash and no balance moved while the wallet is free, released; each with one notification. It then reads the league's clock again (the gate, the warm-up dinner, the season's end) and picks the ask loop up from its saved state.

## What the unit carries

`node`, the runtime's `bin.mjs`, `run <name> --supervised`, and two environment variables: `PATH` (the folders `node`, `baw`, `claude` and `codex` are found in now, then the system's) and `FEAST_LEAGUE_HOME`. Nothing else of the shell's environment is copied. A keyed `FEAST_MAINNET_RPC_URL` is never written by the command: add it to the unit yourself if you use one (`EnvironmentVariables` in the plist, an `Environment=` line in the unit). Without it the runtime uses the Binance dataseed, with the public fallbacks behind it.

## By hand

The same files, for a machine where `FL daemon` cannot run (replace `<name>`, `<node>`, `<bin.mjs>`, `<PATH>` and `<home>`; `<home>` is the league home, `~/.feast-league` by default, written out in full).

macOS, `~/Library/LaunchAgents/meme.feast.league.<name>.plist`, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/meme.feast.league.<name>.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>meme.feast.league.<name></string>
  <key>ProgramArguments</key>
  <array>
    <string><node></string>
    <string><bin.mjs></string>
    <string>run</string>
    <string><name></string>
    <string>--supervised</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string><PATH></string>
    <key>FEAST_LEAGUE_HOME</key><string><home></string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string><home>/agents/<name>/runtime.out</string>
  <key>StandardErrorPath</key><string><home>/agents/<name>/runtime.out</string>
</dict>
</plist>
```

Linux, `~/.config/systemd/user/feast-league-<name>.service`, then `systemctl --user daemon-reload && systemctl --user enable --now feast-league-<name>.service`:

```ini
[Unit]
Description=Feast league agent <name>
After=network-online.target
Wants=network-online.target

[Service]
ExecStart="<node>" "<bin.mjs>" "run" "<name>" "--supervised"
Environment="PATH=<PATH>"
Environment="FEAST_LEAGUE_HOME=<home>"
Restart=on-failure
RestartSec=60
StandardOutput=append:<home>/agents/<name>/runtime.out
StandardError=append:<home>/agents/<name>/runtime.out

[Install]
WantedBy=default.target
```

Windows has no `FL daemon`: run the agent on a machine that stays up (a server or a cloud computer), or keep this one awake.
