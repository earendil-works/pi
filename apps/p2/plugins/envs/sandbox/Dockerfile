# Fallback for hosts that cannot run Gondolin directly (no Node 22+, or a QEMU older than 7.2, e.g. Ubuntu 22.04's 6.2):
# the sandbox supervisors and their VMs run in this container instead, with the host's /dev/kvm passed in and the
# host user's home mounted at the same path. Only Node and QEMU: Gondolin and the launcher come from the launcher's
# directory in that home. p2-sandbox.sh builds it when it picks Docker, tagged with this file's hash.
FROM node:24-trixie-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends qemu-system-x86 qemu-system-arm qemu-utils ca-certificates \
	&& rm -rf /var/lib/apt/lists/*
