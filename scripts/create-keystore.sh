#!/usr/bin/env bash
# Creates the Android release signing keystore and prints the values to store
# as GitHub repository secrets. Run it once on your own computer (needs Java's
# keytool). KEEP THE .jks FILE AND PASSWORD SAFE: without them you can never
# publish an update for the installed app.
set -euo pipefail

OUT="${1:-basterminal-release.jks}"
ALIAS="${2:-basterminal}"

if [ -e "$OUT" ]; then
  echo "File $OUT sudah ada, tidak ditimpa." >&2
  exit 1
fi

read -rsp "Password keystore (min. 6 karakter): " PASS; echo
read -rsp "Ulangi password: " PASS2; echo
[ "$PASS" = "$PASS2" ] || { echo "Password tidak sama." >&2; exit 1; }
[ ${#PASS} -ge 6 ] || { echo "Password terlalu pendek." >&2; exit 1; }

keytool -genkeypair -v -keystore "$OUT" -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass "$PASS" -keypass "$PASS" \
  -dname "CN=BasTerminal, O=bastronika, C=ID" >/dev/null

B64_FILE="$OUT.base64.txt"
base64 < "$OUT" | tr -d '\n' > "$B64_FILE"

cat <<INFO

Keystore dibuat: $OUT
Tambahkan secret berikut di GitHub: Settings → Secrets and variables → Actions → New repository secret

  ANDROID_KEYSTORE_BASE64   = isi file $B64_FILE
  ANDROID_KEYSTORE_PASSWORD = (password yang tadi Anda ketik)
  ANDROID_KEY_ALIAS         = $ALIAS
  ANDROID_KEY_PASSWORD      = (password yang sama)

Setelah itu hapus $B64_FILE, dan simpan $OUT + password di tempat aman (password manager / backup).
INFO
