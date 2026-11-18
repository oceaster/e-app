The Plan button on an owned e-server now opens the change-plan page. It was throwing a ReferenceError before it could switch views, so the button looked inert; the page now reads the last published plan list, shows the current plan, and leaves the change button disabled until a different plan is chosen.

The camera and microphone question can be answered again. In 1.0.24 the screen reloaded itself as fast as it could load, so Allow and Deny could not be reached; 1.0.25 asks once, remembers your answer for that e-server on this device, and keeps the camera publishing after you allow it.

e-server desktop client for Windows 10+ (x64), Ubuntu, Arch Linux and Linux AppImage (x86_64). Windows installers are unsigned; verify the source repository and SHA256SUMS before running. Linux AppImage may require FUSE 2.
