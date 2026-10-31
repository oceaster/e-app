e-server desktop client for Windows 10+ (x64), Ubuntu, Arch Linux and Linux AppImage (x86_64). Install the client, connect to your private network or VPN, and enter your e-server HTTPS address. No server credentials are bundled into these installers.

The client's package name is now `e-app` — the repository's own name — so a package manager lists what you installed as `e-app` instead of an internal label. Nothing you see inside the app changes: the product, the sign-in, the server list and the way it updates are the same as the previous release.

If you are on 1.0.3 or 1.0.4 this release arrives on its own: those builds already accept every name this package has carried, including this one. If you are on 1.0.2 or older and did not install 1.0.3, install this one by hand once — builds older than 1.0.3 cannot read a renamed update package, so they will not update themselves. After that, updates are automatic again.

Windows installers are currently unsigned. SmartScreen may warn; verify the source repository and SHA256SUMS before running. Linux AppImage may require FUSE 2. macOS, ARM and mobile clients are not offered.
