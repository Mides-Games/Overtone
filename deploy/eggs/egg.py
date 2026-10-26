"""Write the importable Reviactyl (Pterodactyl PTDL_v2) eggs of Overtone.

    python deploy/eggs/egg.py           write deploy/eggs/egg-overtone-*.json
    python deploy/eggs/egg.py --check   the committed JSONs are current and egg-shaped

An egg is a JSON with three things in it: the install script, the startup
line and the variables. Typing it into the panel's form is twenty fields and
a textarea; this writes it ready for Admin -> Nests -> Import Egg, the way
Mides-Projects/Cinder's eggs/egg.js does.

The install script lives in install.sh, where it reads and lints as a script,
and is copied into each egg here: two hand-kept copies of the same bash, one in
a file and one inside a JSON string, is the one that goes stale. The JSONs are
committed anyway, so a human can import one without running anything, and
--check fails when they no longer match what this file would write.

Standard library only.
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
AUTHOR = "dev@midesprojects.com"
REPO = "https://github.com/Mides-Projects/Overtone.git"
INSTALLER = "ghcr.io/pterodactyl/installers:debian"

# Debian images, not the panel's own Alpine ones: numpy, numba, scipy and
# onnxruntime publish manylinux wheels only, and ghcr.io/reviactyl/images'
# Python is musl. The Node image is Debian too, so both build the same way.
NODE_IMAGES = {"Node.js 24": "ghcr.io/parkervcp/yolks:nodejs_24"}
PYTHON_IMAGES = {"Python 3.14": "ghcr.io/parkervcp/yolks:python_3.14"}
# The official image, run as it is: Wings starts an image's own entrypoint and
# command and never reads the egg's startup line for an image that does not
# eval $STARTUP, so the server is configured through the environment only.
POSTGRES_IMAGES = {"PostgreSQL 18": "docker.io/library/postgres:18"}

# The keys of an egg as the panel exports one (PTDL_v2), in its order: checked
# against Cinder's eggs/egg.js and parkervcp/eggs' generic Node.js and
# PostgreSQL 16 eggs, 2026-10-26.
EGG_KEYS = ["_comment", "meta", "exported_at", "name", "author", "description", "features",
            "docker_images", "file_denylist", "startup", "config", "scripts", "variables"]
CONFIG_KEYS = ["files", "startup", "logs", "stop"]
INSTALL_KEYS = ["script", "container", "entrypoint"]
VARIABLE_KEYS = ["name", "description", "env_variable", "default_value", "user_viewable",
                 "user_editable", "rules", "field_type"]


def var(name, env, description, default="", rules="nullable|string", viewable=True, editable=False):
    """One egg variable. Not editable by default: a server's owner is not its admin."""
    return {
        "name": name,
        "description": description,
        "env_variable": env,
        "default_value": default,
        "user_viewable": viewable,
        "user_editable": editable,
        "rules": rules,
        "field_type": "text",
    }


def secret(name, env, description, rules="nullable|string"):
    """Hidden from the client panel; only a panel admin reads it."""
    return var(name, env, description, rules=rules, viewable=False)


def git_variables():
    return [
        var("Repository", "GIT_ADDRESS",
            "The repository cloned at install and fast-forwarded at start, over https.",
            default=REPO, rules="required|string|starts_with:https://"),
        var("Branch", "BRANCH",
            "master for production, experimental for staging. Changing it takes a reinstall, "
            "which switches the clone; a start never changes branch on its own.",
            default="master", rules="required|string|in:master,experimental"),
        var("Auto update", "AUTO_UPDATE",
            "1 = fast-forward to origin/BRANCH on every start, so a restart is the release. "
            "Never a merge or a reset: a checkout that cannot fast-forward starts as it is, and says so.",
            default="1", rules="required|boolean"),
        var("User upload", "USER_UPLOAD",
            "1 = the install does not clone and a start does not update: the files are uploaded by hand.",
            default="0", rules="required|boolean"),
        secret("Deploy token", "GIT_TOKEN",
               "Read-only token while the repository is private (a fine-grained token with Contents: read). "
               "Sent as a header, never written to .git/config or printed. Empty once it is public."),
        var("Rollback commit", "ROLLBACK_COMMIT",
            "A commit this server had on BRANCH (see .overtone/deployed.log). When set, the server starts "
            "there and does not update; clear it to return to BRANCH.",
            rules="nullable|string|regex:/^[0-9a-f]{7,40}$/"),
    ]


def app_egg(role, title, description, images, done, variables):
    install = (HERE / "install.sh").read_text(encoding="utf-8").replace("@ROLE@", role)
    return {
        "_comment": "Written by deploy/eggs/egg.py. Do not edit: edit deploy/eggs/ and run it again.",
        "meta": {"version": "PTDL_v2", "update_url": None},
        "exported_at": "2026-10-26T00:00:00+00:00",
        "name": f"Overtone {title}",
        "author": AUTHOR,
        "description": description,
        "features": None,
        "docker_images": images,
        "file_denylist": [],
        "startup": f"bash deploy/eggs/start.sh {role}",
        "config": {
            "files": "{}",
            "startup": json.dumps({"done": done}),
            "logs": "{}",
            # The yolks' stop signal: SIGINT, so a process finishes what it holds.
            "stop": "^C",
        },
        "scripts": {"installation": {"script": install, "container": INSTALLER, "entrypoint": "bash"}},
        "variables": git_variables() + variables,
    }


def web():
    return app_egg(
        "web", "web",
        "The Overtone website: builds site/web with pnpm and serves site/web/dist with "
        "deploy/web/serve.mjs, which forwards /api to overtone-api so the browser sees one origin. "
        "The only Overtone server the TLS proxy publishes.",
        NODE_IMAGES, "overtone-web: listening on",
        [var("API upstream", "API_UPSTREAM",
             "Where /api goes: this environment's overtone-api, http://<allocation ip>:<port>, "
             "the address and port of its allocation on the Docker bridge (see the panel). No trailing slash.",
             rules="required|string|starts_with:http://"),
         var("Trusted proxy hops", "TRUSTED_PROXY_HOPS",
             "Proxies in front of this server: 1 for the TLS proxy. serve.mjs keeps that many "
             "X-Forwarded-For entries plus the connection's address and drops what a client wrote "
             "before them. The API's TRUST_PROXY is this + 1.",
             default="1", rules="required|integer|between:0,10"),
         var("HSTS", "HSTS",
             "1 = every page carries Strict-Transport-Security (one year). The site is served over "
             "https only; 0 is for a server reached over plain http.",
             default="1", rules="required|boolean"),
         secret("Proxy secret", "PROXY_SECRET",
                "The same value as this environment's overtone-api PROXY_SECRET, 32+ characters. Sent "
                "with every request forwarded to the API, which answers 404 without it: the API's own "
                "port is public on the node.",
                rules="required|string|min:32")],
    )


def api():
    return app_egg(
        "api", "api",
        "The Overtone API (Express 5): runs site/api's migrations, then site/api's server, on the "
        "server's allocation. Not published on its own: overtone-web forwards /api to it. Its port is "
        "reachable on the node all the same, so it answers only requests carrying PROXY_SECRET "
        "(from overtone-web) or WORKER_TOKEN (the worker's /api/internal).",
        NODE_IMAGES, ["overtone-api: listening on", "listening on port"],
        [
            secret("Database URL", "DATABASE_URL", "postgres://user:password@host:port/database"),
            secret("Session secret", "SESSION_SECRET", "Signs session cookies."),
            secret("Token key", "TOKEN_KEY", "Encrypts stored tokens."),
            var("Mides auth URL", "MIDES_AUTH_URL", "The Mides SSO."),
            var("Mides web URL", "MIDES_WEB_URL", "Mides-Dev-Web, for profiles and the wall."),
            var("Mides app", "MIDES_APP", "This app's name in the Mides SSO."),
            var("Site URL", "SITE_URL", "The public origin of this environment, https, no trailing slash."),
            var("Trust proxy", "TRUST_PROXY",
                "Proxies in front of the API: 2 = the TLS proxy and overtone-web. Decides the client "
                "address the rate limit counts; too low puts every visitor in one bucket. "
                "overtone-web's TRUSTED_PROXY_HOPS + 1.",
                default="2", rules="required|integer|between:0,10"),
            secret("Proxy secret", "PROXY_SECRET",
                   "32+ characters, the same value as this environment's overtone-web PROXY_SECRET. "
                   "Every request without it in X-Overtone-Proxy gets a 404, except the worker's "
                   "/api/internal routes, which demand WORKER_TOKEN instead.",
                   rules="required|string|min:32"),
            secret("Worker token", "WORKER_TOKEN",
                   "32+ characters, the same value as this environment's overtone-worker WORKER_TOKEN: "
                   "the bearer of /api/internal.",
                   rules="required|string|min:32"),
            var("Anonymous daily limit", "ANON_DAILY_LIMIT", "Analyses per day without an account (default 5)."),
            var("User daily limit", "USER_DAILY_LIMIT", "Analyses per day with a Mides account (default 50)."),
            var("Max audio seconds", "MAX_AUDIO_SECONDS", "Longest audio accepted (default 600)."),
            var("Max upload MB", "MAX_UPLOAD_MB", "Largest upload, checked before the body is read (default 40)."),
            var("Job timeout", "JOB_TIMEOUT_S",
                "Seconds a job may run before it goes back to the queue; two attempts in all (default 900)."),
            var("Spool folder", "SPOOL_DIR",
                "Where uploads wait for the worker; deleted when the result arrives (ADR-W4). Inside the "
                "server's disk, so a restart does not lose the queue's audio.",
                default="/home/container/.overtone/spool", rules="required|string|starts_with:/home/container/"),
        ],
    )


def worker():
    return app_egg(
        "worker", "worker",
        "The Overtone analysis worker (v3 Python engine, worker/main.py): claims jobs from overtone-api "
        "over HTTP, analyses one at a time, posts the result; the API then deletes the audio. Installs "
        "python/requirements.lock and the Beat This! model (Git LFS). Give it a CPU limit and pinning: "
        "one analysis wants about five cores and 1.5 GB of RAM. More analyses at once = more worker servers.",
        PYTHON_IMAGES, "overtone-worker: ready",
        [
            var("API", "OVERTONE_API",
                "This environment's overtone-api, http://<allocation ip>:<port>, reached directly (never "
                "through overtone-web, which does not forward /api/internal). No trailing slash.",
                rules="required|string|starts_with:http"),
            secret("Worker token", "WORKER_TOKEN",
                   "The same value as this environment's overtone-api WORKER_TOKEN.",
                   rules="required|string|min:32"),
            var("Poll seconds", "WORKER_POLL_S", "Seconds between claims while the queue is empty.",
                default="2", rules="required|numeric|min:0.2"),
            var("Worker threads", "WORKER_THREADS",
                "Threads per math library (OpenMP, BLAS, numba, and the worker's onnxruntime session): "
                "the server's CPU limit / 100. Empty = one per core of the whole node, which a CPU limit "
                "then throttles.",
                default="4", rules="nullable|integer|min:1"),
        ],
    )


def db():
    return {
        "_comment": "Written by deploy/eggs/egg.py. Do not edit: edit deploy/eggs/ and run it again.",
        "meta": {"version": "PTDL_v2", "update_url": None},
        "exported_at": "2026-10-26T00:00:00+00:00",
        "name": "Overtone db",
        "author": AUTHOR,
        "description":
            "PostgreSQL for Overtone, from the official image, with its data in /home/container/pgdata so "
            "the panel's backups and disk limit cover it. One server for both environments: a database "
            "per environment.",
        "features": None,
        "docker_images": POSTGRES_IMAGES,
        "file_denylist": [],
        # Shown in the panel only. The official image runs its own entrypoint and
        # `postgres`; Wings never evaluates this line for it.
        "startup": "postgres",
        "config": {
            "files": "{}",
            "startup": json.dumps({"done": "database system is ready to accept connections"}),
            "logs": "{}",
            # SIGINT is PostgreSQL's fast shutdown: open transactions roll back, nothing is lost.
            "stop": "^C",
        },
        "scripts": {"installation": {
            "script": (HERE / "install-db.sh").read_text(encoding="utf-8"),
            "container": INSTALLER,
            "entrypoint": "bash",
        }},
        "variables": [
            var("Port", "PGPORT",
                "The server's allocation port. PostgreSQL listens where PGPORT says, and Wings maps the "
                "allocation to the same port inside the container.",
                rules="required|integer|between:1024,65535"),
            var("Superuser", "POSTGRES_USER",
                "Created on the first start, with the password below. The apps never use it: each "
                "environment gets its own role (docs/deploy.md).",
                default="postgres", rules="required|string|alpha_dash"),
            secret("Superuser password", "POSTGRES_PASSWORD",
                   "At least 24 characters. Read on the first start only; change it later with ALTER ROLE.",
                   rules="required|string|min:24"),
            var("First database", "POSTGRES_DB", "Created on the first start: production's.",
                default="overtone", rules="required|string|alpha_dash"),
            var("Data directory", "PGDATA",
                "Under /home/container, or the data is outside the server's disk and its backups.",
                default="/home/container/pgdata", rules="required|string|in:/home/container/pgdata"),
        ],
    }


EGGS = {"overtone-web": web, "overtone-api": api, "overtone-worker": worker, "overtone-db": db}


def render(make):
    return json.dumps(make(), indent=4, ensure_ascii=False) + "\n"


def shape_errors(name, egg):
    errors = []
    say = errors.append
    if list(egg) != EGG_KEYS:
        say(f"{name}: keys {list(egg)}")
    if egg.get("meta") != {"version": "PTDL_v2", "update_url": None}:
        say(f"{name}: meta {egg.get('meta')}")
    if list(egg.get("config", {})) != CONFIG_KEYS:
        say(f"{name}: config keys {list(egg.get('config', {}))}")
    for k in CONFIG_KEYS:
        v = egg["config"].get(k)
        if not isinstance(v, str):
            say(f"{name}: config.{k} is not a string")
        elif k != "stop":
            json.loads(v)
    if list(egg.get("scripts", {}).get("installation", {})) != INSTALL_KEYS:
        say(f"{name}: scripts.installation keys")
    if "\n" in egg["startup"]:
        say(f"{name}: the startup is more than one line")
    if not egg["docker_images"]:
        say(f"{name}: no docker image")
    seen = set()
    for v in egg["variables"]:
        if list(v) != VARIABLE_KEYS:
            say(f"{name}: variable {v.get('env_variable')} keys {list(v)}")
        if v["env_variable"] in seen:
            say(f"{name}: {v['env_variable']} twice")
        seen.add(v["env_variable"])
        if not isinstance(v["default_value"], str):
            say(f"{name}: {v['env_variable']} default is not a string")
    return errors


def main(argv):
    check = "--check" in argv
    failed = []
    for name, make in EGGS.items():
        out = HERE / f"egg-{name}.json"
        text = render(make)
        failed += shape_errors(name, json.loads(text))
        if check:
            if not out.exists() or out.read_text(encoding="utf-8") != text:
                failed.append(f"{out.name} is not what egg.py writes: run python deploy/eggs/egg.py")
        else:
            out.write_text(text, encoding="utf-8", newline="\n")
            print(f"[overtone] {out.relative_to(HERE.parent.parent)}")
    for line in failed:
        print(f"[overtone] {line}")
    if check and not failed:
        print(f"[overtone] {len(EGGS)} eggs current and PTDL_v2-shaped")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
