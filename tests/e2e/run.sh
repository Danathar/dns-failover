#!/bin/sh
# Run the end-to-end test in a throwaway Debian container, so nothing on the
# host (dnsmasq, systemd units, /run, Tailscale) is touched. Uses podman, or
# docker when podman is absent. Override the image with E2E_IMAGE.
set -eu

root=$(CDPATH="" cd -- "$(dirname -- "$0")/../.." && pwd)
image=${E2E_IMAGE:-public.ecr.aws/docker/library/debian:12}

if command -v podman >/dev/null 2>&1; then
    engine=podman
elif command -v docker >/dev/null 2>&1; then
    engine=docker
else
    echo "tests/e2e/run.sh: need podman or docker" >&2
    exit 1
fi

# The repository is mounted read-only; the container is removed on exit.
exec "$engine" run --rm \
    -v "$root:/src:ro,Z" \
    -e SRC=/src \
    "$image" \
    bash /src/tests/e2e/in-container.sh
