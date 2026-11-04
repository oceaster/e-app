The e-server list no longer flashes an error while it is still loading. If the account service is slow, the list waits for it instead of showing a retry a moment before the servers appear; if the read genuinely fails, it still says so and offers a retry.

Your servers now appear immediately after signing in: the account service no longer answers a fresh sign-in from a cold start, which was taking ten seconds and leaving the list empty in the meantime.

After 30 minutes without interaction, e-server asks for the instance PIN again. If the PIN is not entered within ten minutes, the client disconnects and returns to your e-server list while keeping your Easter Company account signed in.

e-server desktop client for Windows 10+ (x64), Ubuntu, Arch Linux and Linux AppImage (x86_64). Windows installers are unsigned; verify the source repository and SHA256SUMS before running. Linux AppImage may require FUSE 2.
