#!/bin/sh
# p2's sandbox launcher on a host environment. `check` reports whether and how Gondolin can run here (JSON). Every other
# command picks the runtime (natively when Node >= 22, QEMU >= 7.2 and /dev/kvm are usable, else Docker), installs it
# once, then runs p2-sandbox.mjs there with the same arguments. stdout belongs to that program (it carries pi-env's
# protocol), so setup output goes to stderr. Each launcher version has its own directory (named by its content);
# sandboxes keep running across versions.
set -eu
D=$(cd "$(dirname "$0")" && pwd)

qemu_bin() {
	case "$(uname -m)" in
	x86_64 | amd64) echo qemu-system-x86_64 ;;
	aarch64 | arm64) echo qemu-system-aarch64 ;;
	*) echo qemu-system-unsupported ;;
	esac
}
qemu_version() {
	command -v "$(qemu_bin)" >/dev/null 2>&1 || return 0
	"$(qemu_bin)" --version 2>/dev/null | head -n 1 | sed -n 's/.*version \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p'
}
qemu_ok() {
	v=$(qemu_version)
	[ -n "$v" ] || return 1
	major=${v%%.*}
	minor=${v#*.}
	[ "$major" -gt 7 ] || { [ "$major" -eq 7 ] && [ "$minor" -ge 2 ]; }
}
node_version() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node' 2>/dev/null || true; }
node_ok() {
	v=$(node_version)
	[ -n "$v" ] && [ "${v%%.*}" -ge 22 ]
}
kvm_ok() { [ -r /dev/kvm ] && [ -w /dev/kvm ]; }
docker_ok() { [ -e /dev/kvm ] && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

runtime() {
	if [ "$(uname -s)" != Linux ]; then
		echo none
	elif kvm_ok && qemu_ok && node_ok; then
		echo native
	elif docker_ok; then
		echo docker
	else
		echo none
	fi
}

if [ "${1:-}" = check ]; then
	r=$(runtime)
	kvm=false
	kvm_ok && kvm=true
	docker=false
	docker_ok && docker=true
	printf '{"runtime":"%s","system":"%s","arch":"%s","kvm":%s,"kvmDevice":%s,"qemu":"%s","node":"%s","docker":%s}\n' \
		"$r" "$(uname -s)" "$(uname -m)" "$kvm" "$([ -e /dev/kvm ] && echo true || echo false)" \
		"$(qemu_version)" "$(node_version)" "$docker"
	exit 0
fi

# Setup runs under a lock: two sessions connecting at once must not install or create the container twice.
lock() {
	if command -v flock >/dev/null 2>&1; then
		exec 9>"$D/.lock"
		flock 9
	fi
}
unlock() { exec 9>&-; }

# Gondolin and its dependencies, from package-lock.json into this version's directory, once.
install_gondolin() {
	if [ ! -f "$D/.installed" ]; then
		lock
		if [ ! -f "$D/.installed" ]; then
			echo "p2-sandbox: installing Gondolin in $D" >&2
			"$@" sh -c 'cd "$1" && npm ci --ignore-scripts --no-audit --no-fund >&2' sh "$D"
			touch "$D/.installed"
		fi
		unlock
	fi
}

case "$(runtime)" in
native)
	install_gondolin
	exec node "$D/p2-sandbox.mjs" "$@"
	;;
docker)
	# Named by the Dockerfile only (Node and QEMU), not by the launcher version: launcher versions of several p2
	# installations share the container and run their own files from their directories in the shared home.
	tag=$(sha256sum "$D/Dockerfile" | cut -c1-16)
	image="p2-sandbox:$tag"
	container="p2-sandbox-$(id -u)-$tag"
	if [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" != true ]; then
		lock
		if [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)" != true ]; then
			if ! docker image inspect "$image" >/dev/null 2>&1; then
				echo "p2-sandbox: building the Docker image $image (first time only)" >&2
				docker build -q -t "$image" - <"$D/Dockerfile" >&2
			fi
			docker rm -f "$container" >/dev/null 2>&1 || true
			docker run -d --name "$container" --restart unless-stopped --init \
				--device /dev/kvm --group-add "$(stat -c %g /dev/kvm)" \
				--user "$(id -u):$(id -g)" -e HOME="$HOME" -v "$HOME:$HOME" \
				"$image" sleep infinity >/dev/null
		fi
		unlock
	fi
	install_gondolin docker exec -i "$container"
	exec docker exec -i -e P2_SANDBOX_RUNTIME=docker "$container" node "$D/p2-sandbox.mjs" "$@"
	;;
*)
	echo "p2-sandbox: this host cannot run sandboxes (needs Linux with /dev/kvm, and Node >= 22 with QEMU >= 7.2 or Docker)" >&2
	exit 3
	;;
esac
