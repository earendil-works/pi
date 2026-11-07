#!/bin/sh
# p2's sandbox launcher on a host environment. `check` reports whether Gondolin can run here (JSON): Linux, a usable
# /dev/kvm, Node >= 22 and QEMU >= 7.2. Every other command installs Gondolin once, then runs p2-sandbox.mjs with the
# same arguments. stdout belongs to that program (it carries pi-env's protocol), so setup output goes to stderr. Each
# launcher version has its own directory (named by its content); sandboxes keep running across versions.
set -eu
D=$(cd "$(dirname "$0")" && pwd)
# Programs are found on the PATH of SSH commands and in ~/.local/bin, the user's own installations (e.g. a QEMU built
# there), which SSH commands do not have on their PATH. Gondolin starts QEMU and qemu-img through the same PATH.
PATH="$HOME/.local/bin:$PATH"
export PATH

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

runtime() {
	if [ "$(uname -s)" = Linux ] && kvm_ok && qemu_ok && node_ok; then echo native; else echo none; fi
}

if [ "${1:-}" = check ]; then
	r=$(runtime)
	kvm=false
	kvm_ok && kvm=true
	printf '{"runtime":"%s","system":"%s","arch":"%s","kvm":%s,"kvmDevice":%s,"qemu":"%s","node":"%s"}\n' \
		"$r" "$(uname -s)" "$(uname -m)" "$kvm" "$([ -e /dev/kvm ] && echo true || echo false)" \
		"$(qemu_version)" "$(node_version)"
	exit 0
fi

# Installing runs under a lock: two sessions connecting at once must not install twice.
if [ "$(runtime)" != native ]; then
	echo "p2-sandbox: this host cannot run sandboxes (needs Linux, a usable /dev/kvm, Node >= 22 and QEMU >= 7.2)" >&2
	exit 3
fi
if [ ! -f "$D/.installed" ]; then
	if command -v flock >/dev/null 2>&1; then
		exec 9>"$D/.lock"
		flock 9
	fi
	if [ ! -f "$D/.installed" ]; then
		echo "p2-sandbox: installing Gondolin in $D" >&2
		(cd "$D" && npm ci --ignore-scripts --no-audit --no-fund </dev/null >&2)
		touch "$D/.installed"
	fi
	exec 9>&-
fi
exec node "$D/p2-sandbox.mjs" "$@"
