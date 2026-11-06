"""A real e-server publish socket, mounted on its own — the e-app journey's server.

`scripts/live-feeds-e2e.cjs` starts this, points the real desktop client at it, and then reads what
the SOCKET actually did: the registry's feed, the MJPEG the dashboard would draw, the fragment the
security page embeds, and the segment file on disk. It exists because the alternative is either a
fake server that agrees with the client (which proves nothing about the wire) or the whole e-server
service (whose startup owns the event timeline, the agent channels and the harness state this box is
using — a test must not write there).

So it mounts THE REAL MODULE and nothing else: `api/live_feeds.register(app)` on the e-server tree,
which brings the registry, the identity resolution from the PIN session cookie, the recorder that
runs ffmpeg (through `e_server.streaming.client_feed`), Diana's fragment renderer, and both read
routes. What it does NOT mount is the security gate that makes the dashboard administrator-only —
that is the server repository's own proof (its `tests/test_security_gate.py`), not the client's, and
this fixture never runs on a machine anybody depends on: it writes to a temporary storage root and a
temporary profile database, given as arguments.

WHAT IS FABRICATED, AND SAID OUT LOUD: the PIN session and its account binding. A real person gets
the first through the instance's PIN gate and the second through a Company sign-in handoff; this
journey creates both directly in its own temporary profile database, because the thing under test is
the CLIENT's publisher and the PIN is the owner's credential, not a test fixture's.

    python3 scripts/live-feeds-fixture.py --server-tree /root/wt-live-feeds \
        --port 18431 --storage /tmp/x/security --profile-db /tmp/x/profiles.sqlite3 \
        --token <token> --account-id 2

Prints one line — `live-feeds fixture listening on <origin>` — once it is answering, and stops on
SIGTERM.
"""
from __future__ import annotations

import argparse
import os
import sys
import time

#: The document the client's window loads. It only has to be a real page on this origin: the
#: publisher runs in the connected window's preload, so any document here proves the client half.
PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>live-feeds fixture</title></head>
<body><p>The e-app's window is connected to this origin.</p></body></html>
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server-tree", required=True, help="an e-server checkout with api/live_feeds.py")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--storage", required=True, help="temporary SECURITY_STORAGE root")
    parser.add_argument("--profile-db", required=True, help="temporary profile/browser database")
    parser.add_argument("--token", required=True, help="the PIN session token this fixture accepts")
    parser.add_argument("--account-id", default="2", help="the account the session is bound to")
    parser.add_argument("--tls-cert", default=None)
    parser.add_argument("--tls-key", default=None)
    args = parser.parse_args()

    sys.path.insert(0, os.path.abspath(args.server_tree))
    os.makedirs(args.storage, exist_ok=True)
    os.environ["SECURITY_STORAGE"] = os.path.abspath(args.storage)
    os.environ["E_SERVER_PROFILE_DB"] = os.path.abspath(args.profile_db)

    from core.browser_profiles import ProfileStore
    from fastapi import FastAPI
    from fastapi.responses import HTMLResponse

    binding = ProfileStore(os.path.abspath(args.profile_db))
    binding.bind(args.token, str(args.account_id), "live-feeds-fixture", time.time() + 6 * 3600)

    import api.live_feeds as live_feeds

    app = FastAPI()

    @app.get("/healthz")
    def healthz() -> dict:
        return {"ok": True}

    @app.get("/")
    def index() -> HTMLResponse:
        return HTMLResponse(PAGE)

    @app.get("/_session")
    def session_gate():
        """Stands in for the instance's PIN gate: it sets the cookie a real sign-in would set.

        The journey loads this route in the client's own window, so the cookie lands in the
        client's session exactly as the real gate's would — no cookie is injected behind the
        window's back.
        """
        from fastapi.responses import RedirectResponse
        response = RedirectResponse("/", status_code=303)
        response.set_cookie("sec_session", args.token, httponly=True, samesite="lax")
        return response

    @app.get("/dashboard")
    def dashboard() -> HTMLResponse:
        """The fragment the security page embeds, from the module everyone else reads."""
        return HTMLResponse("<!doctype html><html><body>" + live_feeds.render_dashboard()
                            + "</body></html>")

    live_feeds.register(app)

    import uvicorn
    origin = ("https" if args.tls_cert else "http") + f"://127.0.0.1:{args.port}"
    print(f"live-feeds fixture listening on {origin}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning",
                ssl_certfile=args.tls_cert, ssl_keyfile=args.tls_key)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
