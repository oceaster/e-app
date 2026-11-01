Fixes a startup failure when e-server redirects to the billing page. The desktop client now keeps the replacement page open instead of quitting with ERR_ABORTED (-3).

The regression is tested in Electron on Linux and Windows, including the real redirect and the original failing behavior.

e-server desktop client for Windows 10+ (x64), Ubuntu, Arch Linux and Linux AppImage (x86_64). Windows installers are unsigned; verify the source repository and SHA256SUMS before running. Linux AppImage may require FUSE 2.
