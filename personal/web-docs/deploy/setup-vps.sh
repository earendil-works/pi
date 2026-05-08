#!/usr/bin/env bash
# Pi Web Docs — VPS-Setup-Skript (idempotent)
#
# Zweck: alles installieren und konfigurieren, was Root-Rechte braucht.
# Frontend-Build und Code liegen in /home/opipi/web-docs/ (per opipi gepflegt).
#
# Voraussetzungen (Phasen, die NICHT dieses Skript erledigt):
#   1. dynu.com: A-Record `docs.og-monschau.de` → 46.225.80.223 (manuell)
#   2. Google Cloud Console: OAuth-Client „Web Docs", Redirect URI
#      `https://docs.og-monschau.de/oauth2/callback`. Liefert CLIENT_ID
#      + CLIENT_SECRET → kommen ins env-File (siehe Schritt 6).
#   3. Code muss schon auf dem VPS liegen (per rsync von Laptop oder
#      git clone in /home/opipi/web-docs/).
#
# Was dieses Skript macht (jede Stufe ist idempotent):
#   A. Pakete installieren (nginx, certbot, snapd-frei via APT, Node ist da)
#   B. oauth2-proxy v7 Binary herunterladen → /usr/local/bin/oauth2-proxy
#   C. /etc/web-docs-oauth2-proxy.env Skelett anlegen (Oliver befüllt es)
#   D. nginx-Vhost-Symlink + reload (mit certbot Auto-TLS)
#   E. systemd-Units verlinken + enable
#   F. Status-Report
#
# Ausführen als root:
#   sudo bash /home/opipi/web-docs/deploy/setup-vps.sh
#   # oder:
#   sudo bash /home/opipi/web-docs/deploy/setup-vps.sh --check   # nur Status anzeigen, nichts ändern

set -euo pipefail

CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then
	CHECK_ONLY=true
fi

DOMAIN="docs.og-monschau.de"
OPIPI_HOME="/home/opipi"
WEBDOCS_DIR="${OPIPI_HOME}/web-docs"
ENV_FILE="/etc/web-docs-oauth2-proxy.env"
OAUTH_BIN="/usr/local/bin/oauth2-proxy"
OAUTH_VERSION="v7.7.1"
NGINX_VHOST_SRC="${WEBDOCS_DIR}/deploy/nginx/${DOMAIN}.conf"
NGINX_VHOST_DST="/etc/nginx/sites-available/${DOMAIN}.conf"
NGINX_VHOST_LINK="/etc/nginx/sites-enabled/${DOMAIN}.conf"
SYSTEMD_PROXY_SRC="${WEBDOCS_DIR}/deploy/systemd/web-docs-proxy.service"
SYSTEMD_PROXY_DST="/etc/systemd/system/web-docs-proxy.service"
SYSTEMD_OAUTH_SRC="${WEBDOCS_DIR}/deploy/systemd/web-docs-oauth2-proxy.service"
SYSTEMD_OAUTH_DST="/etc/systemd/system/web-docs-oauth2-proxy.service"

echo "==> Pi Web Docs VPS-Setup ($(date -Iseconds))"
echo "    CHECK_ONLY=$CHECK_ONLY"
echo "    DOMAIN=$DOMAIN"
echo

if [[ $EUID -ne 0 ]]; then
	echo "Fehler: muss als root laufen (sudo bash $0)"
	exit 1
fi

if [[ ! -d "$WEBDOCS_DIR" ]]; then
	echo "Fehler: $WEBDOCS_DIR existiert nicht. Code zuerst per rsync/clone dorthin pushen."
	exit 1
fi

run() {
	if $CHECK_ONLY; then
		echo "    [CHECK] $*"
	else
		echo "    [RUN ] $*"
		eval "$@"
	fi
}

# === A. Pakete ===
echo "==> A. APT-Pakete prüfen (nginx, certbot, python3-certbot-nginx)"
NEEDED_PKGS=()
for pkg in nginx certbot python3-certbot-nginx; do
	if ! dpkg -s "$pkg" >/dev/null 2>&1; then
		NEEDED_PKGS+=("$pkg")
	fi
done
if [[ ${#NEEDED_PKGS[@]} -gt 0 ]]; then
	echo "    Fehlend: ${NEEDED_PKGS[*]}"
	run "apt-get update -qq && apt-get install -y ${NEEDED_PKGS[*]}"
else
	echo "    Alles installiert."
fi

# === B. oauth2-proxy Binary ===
echo
echo "==> B. oauth2-proxy ($OAUTH_VERSION) installieren"
if [[ -x "$OAUTH_BIN" ]]; then
	current_ver=$("$OAUTH_BIN" --version 2>&1 | head -1 || true)
	echo "    Vorhanden: $current_ver"
else
	echo "    Nicht installiert."
	ARCH="amd64"
	URL="https://github.com/oauth2-proxy/oauth2-proxy/releases/download/${OAUTH_VERSION}/oauth2-proxy-${OAUTH_VERSION}.linux-${ARCH}.tar.gz"
	TMP=$(mktemp -d)
	run "curl -sSfL '$URL' -o '$TMP/oauth2.tgz'"
	run "tar -xzf '$TMP/oauth2.tgz' -C '$TMP' --strip-components=1"
	run "install -m 0755 '$TMP/oauth2-proxy' '$OAUTH_BIN'"
	run "rm -rf '$TMP'"
fi

# === C. ENV-File-Skelett ===
echo
echo "==> C. oauth2-proxy ENV-File ($ENV_FILE)"
if [[ -f "$ENV_FILE" ]]; then
	# Prüfen, ob alle benötigten Variablen gesetzt sind (Wert != PLACEHOLDER)
	missing=0
	for var in OAUTH2_PROXY_CLIENT_ID OAUTH2_PROXY_CLIENT_SECRET OAUTH2_PROXY_COOKIE_SECRET; do
		val=$(grep -E "^${var}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)
		if [[ -z "$val" || "$val" == "REPLACE_ME"* ]]; then
			echo "    [TODO Oliver] $var in $ENV_FILE setzen"
			missing=$((missing+1))
		fi
	done
	if [[ $missing -eq 0 ]]; then
		echo "    Alle Secrets gesetzt."
	fi
else
	echo "    Skelett anlegen."
	if ! $CHECK_ONLY; then
		COOKIE_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '\n=' | cut -c1-32)
		cat > "$ENV_FILE" <<EOF
# /etc/web-docs-oauth2-proxy.env — gelesen von web-docs-oauth2-proxy.service
# Permissions: chmod 640, root:opipi (opipi-Service liest, andere nicht).
#
# OAuth-Credentials: aus Google Cloud Console (siehe ~/web-docs/README.md)
OAUTH2_PROXY_CLIENT_ID=REPLACE_ME_CLIENT_ID
OAUTH2_PROXY_CLIENT_SECRET=REPLACE_ME_CLIENT_SECRET

# Cookie-Secret: zufällig generiert, 32 Zeichen base64. Muss nicht extra
# rotiert werden, außer der Server wurde kompromittiert.
OAUTH2_PROXY_COOKIE_SECRET=$COOKIE_SECRET
EOF
		chown root:opipi "$ENV_FILE"
		chmod 640 "$ENV_FILE"
		echo "    Erzeugt mit zufälligem COOKIE_SECRET. CLIENT_ID + CLIENT_SECRET ergänzen."
	fi
fi

# === D. nginx-Vhost ===
echo
echo "==> D. nginx-Vhost (Symlink → Repo)"
if [[ -L "$NGINX_VHOST_DST" || -f "$NGINX_VHOST_DST" ]]; then
	echo "    sites-available/${DOMAIN}.conf existiert."
else
	run "ln -sf '$NGINX_VHOST_SRC' '$NGINX_VHOST_DST'"
fi
if [[ -L "$NGINX_VHOST_LINK" ]]; then
	echo "    sites-enabled/${DOMAIN}.conf existiert."
else
	run "ln -sf '$NGINX_VHOST_DST' '$NGINX_VHOST_LINK'"
fi

# Bevor nginx geladen wird, brauchen wir das TLS-Cert. Wenn noch nicht vorhanden,
# können wir auch nicht reloaden, weil der Vhost auf das Cert verweist.
if [[ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]]; then
	echo "    TLS-Cert noch nicht vorhanden. Versuche certbot certonly via webroot…"
	# Voraussetzung: DNS A-Record zeigt schon auf VPS. Wenn nicht, schlägt certbot fehl
	# und wir geben eine klare Fehlermeldung aus.
	echo "    DNS-Check: dig +short ${DOMAIN}"
	dig +short "$DOMAIN" || true

	if ! $CHECK_ONLY; then
		# Webroot-Verzeichnis sicherstellen
		mkdir -p /var/www/html

		# Erstmal nginx starten ohne den neuen vhost (Link kurz raus)
		# damit certbot via Port 80 + webroot challenge laufen kann
		rm -f "$NGINX_VHOST_LINK"
		systemctl reload nginx 2>/dev/null || systemctl restart nginx

		# Minimaler Vhost nur für ACME während Cert-Issuance
		ACME_VHOST="/etc/nginx/sites-available/${DOMAIN}-acme.conf"
		cat > "$ACME_VHOST" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    location / { return 404; }
}
EOF
		ln -sf "$ACME_VHOST" "/etc/nginx/sites-enabled/${DOMAIN}-acme.conf"
		systemctl reload nginx

		# Cert holen
		certbot certonly --webroot -w /var/www/html -d "$DOMAIN" \
			--non-interactive --agree-tos --email o.gerets@gmail.com \
			--no-eff-email || {
				echo "    [FEHLER] certbot fehlgeschlagen. Häufige Ursache: A-Record für $DOMAIN zeigt nicht auf 46.225.80.223."
				rm -f "/etc/nginx/sites-enabled/${DOMAIN}-acme.conf"
				exit 1
			}

		# ACME-Vhost weg, echten Vhost wieder rein
		rm -f "/etc/nginx/sites-enabled/${DOMAIN}-acme.conf" "$ACME_VHOST"
		ln -sf "$NGINX_VHOST_DST" "$NGINX_VHOST_LINK"
		nginx -t
		systemctl reload nginx
	fi
else
	echo "    TLS-Cert vorhanden: $(ls -la /etc/letsencrypt/live/${DOMAIN}/fullchain.pem 2>&1 | head -1)"
fi

# === E. systemd-Units ===
echo
echo "==> E. systemd-Units verlinken + enable"
for src in "$SYSTEMD_PROXY_SRC" "$SYSTEMD_OAUTH_SRC"; do
	dst="/etc/systemd/system/$(basename "$src")"
	if [[ -L "$dst" ]]; then
		echo "    $(basename "$dst") bereits verlinkt."
	else
		run "ln -sf '$src' '$dst'"
	fi
done

if ! $CHECK_ONLY; then
	systemctl daemon-reload
fi

# === E2. nginx-Traverse-Recht für /home/opipi ===
# /home/opipi ist 0750 opipi:opipi (Hetzner-Standard für User-Home).
# nginx-Worker laufen als www-data und können sonst nicht ins web-docs/dist/
# traversieren → 403. Lösung: www-data in die opipi-Gruppe aufnehmen.
# Idempotent — usermod -aG kann beliebig oft aufgerufen werden.
echo
echo "==> E2. nginx-Worker (www-data) Traverse-Recht auf /home/opipi"
if id -nG www-data 2>/dev/null | grep -qw opipi; then
	echo "    www-data ist bereits in Gruppe opipi."
else
	echo "    www-data nicht in Gruppe opipi → wird ergänzt."
	run "usermod -aG opipi www-data"
	echo "    Hinweis: nginx muss neu gestartet werden, damit die Gruppe aktiv wird:"
	echo "      systemctl restart nginx"
fi

# === F. Status-Report ===
echo
echo "==> F. Status"
echo "    nginx config syntax: $(nginx -t 2>&1 | tail -2 | head -1)"
echo "    web-docs-proxy.service:        $(systemctl is-enabled web-docs-proxy 2>/dev/null || echo 'not enabled') / $(systemctl is-active web-docs-proxy 2>/dev/null || echo 'inactive')"
echo "    web-docs-oauth2-proxy.service: $(systemctl is-enabled web-docs-oauth2-proxy 2>/dev/null || echo 'not enabled') / $(systemctl is-active web-docs-oauth2-proxy 2>/dev/null || echo 'inactive')"

echo
echo "==> Nächste Schritte"
echo "  1. Falls noch nicht passiert: $ENV_FILE öffnen und"
echo "     OAUTH2_PROXY_CLIENT_ID + _CLIENT_SECRET aus Google Cloud Console eintragen."
echo "  2. Services aktivieren:"
echo "       systemctl enable --now web-docs-proxy web-docs-oauth2-proxy"
echo "  3. Smoke-Test:"
echo "       curl -sI https://${DOMAIN}/  # erwartet: 302 zu /oauth2/sign_in"
echo "  4. Im Browser https://${DOMAIN}/ öffnen → Google-Login → App lädt."
