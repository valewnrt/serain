# Mac companion

An optional small service on the owner's Mac that gives Serain read access to
calendars, reminders and contacts and renders public pages with a real browser.
Reachable only while the Mac is awake, and only through an SSH tunnel.
Why it is built this way and not another: D28 in `docs/ARCHITECTURE.md`. Serain
runs without it; everything it can do is an addition.

Requirements on the Mac: Node 22, pnpm, Xcode Command Line Tools (`swiftc`,
`codesign`), a Git checkout of this repo, Google Chrome for the browser part,
and one earlier SSH login to the server (the host key must be in
`~/.ssh/known_hosts`).

```
./companion/install.sh     # set up or update (idempotent)
./companion/uninstall.sh   # remove everything again, on the server too
```

`install.sh` needs `SERAIN_HOST` (from `.dev.vars`) and at the end asks three times
for macOS permissions. Afterwards:

| What | Where |
|---|---|
| Code (one commit, never the working tree) | `~/Library/Application Support/Serain Companion/app` |
| Token, port, browser on/off | `…/config.json` (0600) |
| Key for the tunnel only | `…/tunnel_ed25519` |
| Logs (only "was asked", never contents) | `…/logs/` |
| launchd | `com.serain.companion`, `com.serain.companion-tunnel` |
| Server | user `serain-companion`, `/etc/ssh/sshd_config.d/serain-companion.conf`, two lines in `/etc/serain/serain.env` |

Turn the browser off: `"browser": false` in `config.json`, then
`launchctl kickstart -k gui/$(id -u)/com.serain.companion`.

After a change to `companion/apple/`, `install.sh` rebuilds the helper, and macOS
asks for the permissions again (the signature is ad hoc and therefore bound to the binary).

Check whether the tunnel is up:

```
launchctl print gui/$(id -u)/com.serain.companion-tunnel | grep -E "state|last exit"
ssh root@<host> 'ss -ltnp | grep 47812'
```
