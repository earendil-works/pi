#!/usr/bin/env bash
# Sets up the signing credentials of .github/workflows/p2-mac-nightly.yml in the GitHub environment `p2-mac-release`.
# Run it yourself in a terminal, not through an agent: keys never reach stdout. They go from files and keychain items
# straight into `gh secret set`, which encrypts them on this machine before upload.
#
#   ./scripts/release-secrets.sh environment            create the environment, limited to main
#   ./scripts/release-secrets.sh certificate-request    make the signing key and a CSR for Apple
#   ./scripts/release-secrets.sh certificate <file.cer> turn Apple's certificate into the signing secrets
#   ./scripts/release-secrets.sh notary <AuthKey_ID.p8> <issuer ID>
#                                                       check an App Store Connect API key, store it for notarytool
#   ./scripts/release-secrets.sh sparkle                make (or reuse) Sparkle's update key, store it
#   ./scripts/release-secrets.sh status                 list what the environment holds (names only)
#
# REPO overrides the repository (default earendil-works/pi).
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${REPO:-earendil-works/pi}"
ENVIRONMENT=p2-mac-release
# Between certificate-request and certificate: the private key waits here, readable by you only.
PENDING="$HOME/.p2-mac-signing"
SPARKLE_ACCOUNT=pi-mac
OPENSSL=/usr/bin/openssl

secret() { gh secret set "$1" --env "$ENVIRONMENT" --repo "$REPO" >/dev/null; echo "  secret $1 set"; }
variable() { gh variable set "$1" --env "$ENVIRONMENT" --repo "$REPO" --body "$2" >/dev/null; echo "  variable $1 = $2"; }

# A directory for this run's intermediate files, removed on exit.
scratch() {
	work="$(mktemp -d)"
	chmod 700 "$work"
	trap 'rm -rf "$work"' EXIT
}

environment() {
	echo "Creating $ENVIRONMENT in $REPO (deployments from main only)"
	gh api -X PUT "repos/$REPO/environments/$ENVIRONMENT" --input - >/dev/null <<-EOF
		{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
	EOF
	if ! gh api "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" --jq '.branch_policies[].name' | grep -qx main; then
		gh api -X POST "repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" -f name=main -f type=branch >/dev/null
	fi
	echo "  done"
}

certificate_request() {
	if [ -e "$PENDING/key.pem" ]; then
		echo "$PENDING/key.pem exists: a request is pending. Finish it with 'certificate <file.cer>', or delete $PENDING."
		exit 1
	fi
	read -r -p "Your name (as on the Apple developer account): " name
	read -r -p "Your Apple ID email: " email
	mkdir -p "$PENDING"
	chmod 700 "$PENDING"
	(umask 077 && "$OPENSSL" genrsa -out "$PENDING/key.pem" 2048 2>/dev/null)
	"$OPENSSL" req -new -key "$PENDING/key.pem" -out "$PENDING/request.csr" -subj "/emailAddress=$email/CN=$name/C=AT"
	cat <<-EOF

		Wrote $PENDING/request.csr (the private key stays next to it).
		1. Open https://developer.apple.com/account/resources/certificates/add (as the team's Account Holder).
		2. Choose "Developer ID Application", profile type "G2 Sub-CA", and upload request.csr.
		3. Download the certificate, then run:
		   ./scripts/release-secrets.sh certificate ~/Downloads/developerID_application.cer
	EOF
}

certificate() {
	local cer="${1:?usage: certificate <file.cer>}"
	[ -e "$PENDING/key.pem" ] || { echo "No pending key in $PENDING; run certificate-request first."; exit 1; }
	scratch
	"$OPENSSL" x509 -inform DER -in "$cer" -out "$work/cert.pem"
	# The certificate must be for the pending key, and a Developer ID Application certificate.
	local key_hash cert_hash identity issuer
	key_hash="$("$OPENSSL" rsa -in "$PENDING/key.pem" -noout -modulus 2>/dev/null | shasum -a 256)"
	cert_hash="$("$OPENSSL" x509 -in "$work/cert.pem" -noout -modulus | shasum -a 256)"
	[ "$key_hash" = "$cert_hash" ] || { echo "$cer is not for the key in $PENDING."; exit 1; }
	identity="$("$OPENSSL" x509 -in "$work/cert.pem" -noout -subject -nameopt multiline | sed -n 's/^ *commonName *= //p')"
	issuer="$("$OPENSSL" x509 -in "$work/cert.pem" -noout -issuer -nameopt multiline | sed -n 's/^ *commonName *= //p')"
	case "$identity" in "Developer ID Application: "*) ;; *) echo "Not a Developer ID Application certificate: $identity"; exit 1 ;; esac
	[ "$issuer" = "Developer ID Certification Authority" ] || { echo "Unexpected issuer: $issuer"; exit 1; }
	echo "Certificate: $identity"

	# The intermediate goes into the .p12, so the runner's keychain has the whole chain.
	curl -fsSL https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer | "$OPENSSL" x509 -inform DER -out "$work/ca.pem"
	local password
	password="$("$OPENSSL" rand -hex 24)"
	# SHA1/3DES: the formats `security import` reads; it rejects newer OpenSSL defaults.
	printf '%s' "$password" | "$OPENSSL" pkcs12 -export -inkey "$PENDING/key.pem" -in "$work/cert.pem" \
		-certfile "$work/ca.pem" -name "$identity" -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
		-passout stdin -out "$work/identity.p12"

	echo "Uploading to $ENVIRONMENT"
	base64 -i "$work/identity.p12" | secret MACOS_CERTIFICATE_P12
	printf '%s' "$password" | secret MACOS_CERTIFICATE_PASSWORD
	variable MACOS_SIGN_IDENTITY "$identity"

	# The login keychain keeps the key: your backup, and local signing with the same identity.
	security import "$work/identity.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$password" -T /usr/bin/codesign >/dev/null
	echo "  imported into your login keychain"
	rm -rf "$PENDING"
	echo "  removed $PENDING"
}

notary() {
	local key="${1:?usage: notary <AuthKey_ID.p8> <issuer ID>}"
	local issuer="${2:?usage: notary <AuthKey_ID.p8> <issuer ID>}"
	local key_id
	key_id="$(basename "$key" .p8)"
	key_id="${key_id#AuthKey_}"
	echo "Checking key $key_id with notarytool"
	if ! xcrun notarytool history --key "$key" --key-id "$key_id" --issuer "$issuer" >/dev/null 2>&1; then
		echo "notarytool rejected the key; check the key file, its ID ($key_id) and the issuer ID."
		exit 1
	fi
	echo "Uploading to $ENVIRONMENT"
	base64 -i "$key" | secret APPLE_NOTARY_KEY
	printf '%s' "$key_id" | secret APPLE_NOTARY_KEY_ID
	printf '%s' "$issuer" | secret APPLE_NOTARY_ISSUER
	echo "Apple lets you download $key once: keep it in a password manager, then delete it here."
}

sparkle() {
	local tool=.build/artifacts/sparkle/Sparkle/bin/generate_keys
	[ -x "$tool" ] || swift package resolve
	scratch
	# Creates the key in your login keychain under its own account, or reuses the one there. It prints the public key.
	"$tool" --account "$SPARKLE_ACCOUNT" >/dev/null
	local public
	public="$("$tool" --account "$SPARKLE_ACCOUNT" -p)"
	"$tool" --account "$SPARKLE_ACCOUNT" -x "$work/sparkle.key" >/dev/null
	echo "Uploading to $ENVIRONMENT"
	secret SPARKLE_PRIVATE_KEY <"$work/sparkle.key"
	variable SPARKLE_PUBLIC_KEY "$public"
	cat <<-EOF
		The private key stays in your login keychain (account $SPARKLE_ACCOUNT): every installed app trusts only it, so
		back it up (generate_keys --account $SPARKLE_ACCOUNT -x <file> into a password manager). Never replace it while
		apps are installed: they would stop updating.
	EOF
}

status() {
	echo "$REPO, environment $ENVIRONMENT"
	echo "secrets:"
	gh secret list --env "$ENVIRONMENT" --repo "$REPO" | sed 's/^/  /'
	echo "variables:"
	gh variable list --env "$ENVIRONMENT" --repo "$REPO" | sed 's/^/  /'
}

case "${1:-}" in
	environment) environment ;;
	certificate-request) certificate_request ;;
	certificate) certificate "${2:-}" ;;
	notary) notary "${2:-}" "${3:-}" ;;
	sparkle) sparkle ;;
	status) status ;;
	*) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
