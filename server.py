#!/usr/bin/env python3
"""BattleBot Designer — combat robot CAD and teardown studio. Serves the app on port 8105."""

import argparse
import os
from typing import Any

from flask import Flask, Response, jsonify, render_template, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = Flask(__name__, template_folder="templates", static_folder=STATIC_DIR)
app.config["TEMPLATES_AUTO_RELOAD"] = True


@app.after_request
def add_headers(response: Any) -> Any:
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/")
def index_page() -> Any:
    return render_template("index.html")


@app.route("/favicon.ico")
def favicon() -> Any:
    return Response(status=204)


@app.route("/static/<path:filename>")
def serve_static_file(filename: str) -> Any:
    return send_from_directory(STATIC_DIR, filename)


@app.route("/api/health", methods=["GET"])
def api_health() -> Any:
    return jsonify({"ok": True, "app": "BattleBot Designer", "port": app.config.get("BBD_PORT", DEFAULT_PORT)})


DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8105


def main() -> None:
    # HOST / PORT environment variables set the defaults; --host / --port override them.
    env_host = os.environ.get("HOST") or DEFAULT_HOST
    env_port = int(os.environ.get("PORT") or DEFAULT_PORT)
    parser = argparse.ArgumentParser(description="BattleBot Designer server")
    parser.add_argument("--host", default=env_host, help=f"Bind host (default: $HOST or {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=env_port, help=f"Bind port (default: $PORT or {DEFAULT_PORT})")
    args = parser.parse_args()
    app.config["BBD_PORT"] = args.port
    app.run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
