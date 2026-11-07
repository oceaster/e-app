# Notices and attribution — the local model engine

This file ships inside the application on purpose, and it must stay readable. Hiding our own design
is the goal; hiding a licence notice or a support fact is not.

## The model

The local model this engine runs is distributed by its licensors under the **OpenMDW License
Agreement, Version 1.1 (OpenMDW-1.1)**. It is not sold or sublicensed here.

The model's own licence text, its model card and any copyright statement shipped with it are
installed UNMODIFIED alongside the weights under the application's own data directory, in the
`NOTICE` files of the model's directory. They are readable at any time, and they are never rewritten
by this application.

## The inference engine

The inference engine is installed as a separate, hash-pinned program under the application's data
directory, and it carries its own licence file (`LICENSE`, or `LICENCE`/`COPYING` where the upstream
uses those names) next to the binary. That file is installed byte for byte and is not modified,
renamed or removed by this application.

Nothing in this application relicenses the model or the engine, and no licence notice is
obfuscated, minified or moved into the application bundle.

## Third-party components

The application itself ships no third-party runtime code for the local engine: the modelling,
planning, download and process-lifetime code is Easter Company's own and is delivered to the
operating system as one bundled file. The engine and the model are downloaded separately, at the
person's request, and remain the property of their licensors.

---

Questions about these notices: Easter Company.
