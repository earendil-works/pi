# Builds and runs Pi.app in the foreground (Ctrl-C quits it and stops a server it started). See README.md.
#
#   make run          own server, local only: port 8798, data in ~/.pi/p2-mac/local (FAKE=1: faux provider)
#   make run-radius   own server connected to Radius: port 8799, data in ~/.pi/p2-mac/radius (signs in on first use)
#   make attach       the p2 already running on 127.0.0.1:8788 with ~/.pi/p2 (ATTACH_PORT, ATTACH_DATA_DIR)
#
# p2 runs one server per data directory and Radius is on exactly when <data>/radius.json exists, so each own-server
# target gets its own data directory and port and leaves the server on 8788 alone.

CHECKOUT ?= $(abspath ../p2)
APP_BIN := build/Pi.app/Contents/MacOS/Pi

LOCAL_PORT ?= 8798
LOCAL_DATA_DIR ?= $(HOME)/.pi/p2-mac/local
RADIUS_PORT ?= 8799
RADIUS_DATA_DIR ?= $(HOME)/.pi/p2-mac/radius
ATTACH_PORT ?= 8788
ATTACH_DATA_DIR ?= $(HOME)/.pi/p2
FAKE ?=

# `-source own` overrides a server chosen in the menu (saved as `source=attached`, which wins over P2MAC_PORT) for this
# launch only: it lands in the argument domain of the user defaults, which is never persisted.
OWN_ENV = P2MAC_CHECKOUT="$(CHECKOUT)" P2MAC_FAKE="$(FAKE)"

.PHONY: build run run-radius radius-login attach clean checkout-ready

build:
	./scripts/build-app.sh

# A fresh worktree has no dependencies: its server would exit at once (ERR_MODULE_NOT_FOUND) behind "Pi is not running".
REPO_ROOT = $(abspath $(CHECKOUT)/../..)
checkout-ready:
	@test -d "$(REPO_ROOT)/node_modules" && test -d "$(REPO_ROOT)/packages/ai/src/providers/data" || { \
		echo "$(REPO_ROOT) is not ready to run p2. Run there:"; \
		echo "  npm install --ignore-scripts && npm run hydrate:model-data"; exit 1; }

run: build checkout-ready
	mkdir -p -m 700 "$(LOCAL_DATA_DIR)"
	$(OWN_ENV) P2MAC_PORT=$(LOCAL_PORT) P2MAC_DATA_DIR="$(LOCAL_DATA_DIR)" $(APP_BIN) -source own

run-radius: build checkout-ready
	@test -f "$(RADIUS_DATA_DIR)/radius.json" || $(MAKE) radius-login
	$(OWN_ENV) P2MAC_PORT=$(RADIUS_PORT) P2MAC_DATA_DIR="$(RADIUS_DATA_DIR)" $(APP_BIN) -source own

# Device-code sign-in to Radius for the radius data directory (PI_RADIUS_GATEWAY picks another gateway).
radius-login:
	mkdir -p -m 700 "$(RADIUS_DATA_DIR)"
	cd "$(CHECKOUT)" && P2_DATA_DIR="$(RADIUS_DATA_DIR)" npm run radius:login

attach: build
	@curl -fsS "http://127.0.0.1:$(ATTACH_PORT)/health" >/dev/null || { echo "No p2 answers on 127.0.0.1:$(ATTACH_PORT)"; exit 1; }
	P2MAC_ATTACH=$(ATTACH_PORT) P2MAC_DATA_DIR="$(ATTACH_DATA_DIR)" $(APP_BIN)

clean:
	rm -rf build .build
