# e-server desktop client

The desktop frontend for an e-server you own or have permission to access. Windows
10+ (x64), Ubuntu, Arch Linux and Linux AppImage (x86_64). macOS and mobile are not
offered. Sign in to your global Easter Company account first, then choose from the
e-servers saved to that account - add one by its HTTPS origin, remove one you no longer
use - and the server you pick asks for its PIN. Private network/VPN access, the PIN and
your Easter Company account are still required. No server address, PIN, Company token or
backend source is bundled into releases.

`npm ci`, `npm test`, `npm start`. `npm run dist:linux` builds AppImage, DEB and
pacman; `npm run dist:windows` builds an NSIS installer on Windows. The release
workflow builds both operating systems and refuses to publish without every
installer, both verified ASAR update payloads and SHA256SUMS. Windows binaries are
unsigned; the download instructions explain SmartScreen accurately.

The entry/updater follows the Easter Co. Launcher's model: an immutable packaged
bootstrap selects a versioned, SHA-256-verified ASAR from user-owned storage. The
runtime, platform, architecture, application identity, size and checksum must all
match before activation. New Electron runtimes require a new installer. Update
checks run at startup and every 15 minutes with jitter and bounded backoff. An
unavailable update service does not claim the client is current or stop access to
an otherwise reachable private server. Updates stage while open and apply only
when unfocused and idle, outside sign-in, transfers, media and unsaved-work guards;
the menu also offers an explicit restart. Active agent work stays on the server.
Patch updates preserve state, minor updates clear HTTP cache, and major updates
clear that server's local sign-in state when it next connects.

The remote renderer has Node integration disabled, a sandbox and context
isolation. Native IPC is limited to the configured main-frame origin. Other HTTPS
links and account providers open in the operating system browser. Microsoft uses
a one-use, short-lived server handoff bound to the existing PIN session; the
browser never receives the desktop PIN cookie or a Company session token. Camera,
microphone, display sharing and notifications require permission. Files use native
save dialogs and normal web uploads/drag-and-drop. Window state, single-instance
handling, tray entry, installer shortcuts and `e-server://connect?server=...` links
are supported. Deep links ask before changing an existing connection.

Client state is per OS user and per server origin. Sign-in persistence requires an
OS-backed secure keyring; when it is unavailable, the session stays in memory.
This protects credentials without borrowing an existing browser's login data.

The public installer control in `site/downloads.js` and `site/downloads.css` is
vendored into e-server and easter.company. Keep the four installer filenames and
both update-manifest names synchronized with the release workflow. Publish a
normal `client-v<package version>` tag, never a prerelease, so `/releases/latest`
and the download buttons resolve to the same version.

Company-first sign-in, account isolation, tray controls and the HTTPS address correction
are described in [docs/COMPANY_LOGIN.md](docs/COMPANY_LOGIN.md).
