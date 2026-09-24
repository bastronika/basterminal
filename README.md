# basterminal

Aplikasi Android & iOS untuk akses SSH, SFTP, tunnel, dan network tools, bergaya **MobaXterm**.

Dibangun dengan [Tauri 2](https://v2.tauri.app): inti Rust (SSH murni lewat [`russh`](https://github.com/Eugeny/russh), tanpa OpenSSH/libssh) dan UI web dengan [xterm.js](https://xtermjs.org). Satu codebase untuk Android, iOS, dan desktop (Linux/Windows/macOS).

## Fitur

| MobaXterm | BasTerminal |
|---|---|
| Session manager | Daftar sesi tersimpan, dikelompokkan per grup, dengan warna, edit/duplikat/hapus |
| Tab terminal | Beberapa sesi SSH sekaligus dalam tab, dengan tombol reconnect |
| Terminal | xterm.js (256 warna, link bisa diklik, resize PTY otomatis) |
| Keyboard | Baris tombol tambahan: ESC, TAB, CTRL/ALT (sticky), panah, HOME/END, PGUP/PGDN, F1–F10, PASTE |
| SFTP browser di sidebar | Jelajah folder, upload, download, rename, chmod, mkdir, file baru, hapus |
| MobaTextEditor | Editor teks remote di tab sendiri: syntax highlighting (shell, Python, JS/TS, JSON, YAML, nginx, Dockerfile, INI/TOML, PHP, SQL, HTML/CSS, Markdown, Go, Rust, C/C++…), nomor baris, cari & ganti (regex), lompat baris, undo/redo, word wrap, Ctrl+S; peringatan jika file berubah di server, line ending CRLF/LF & BOM dipertahankan, file biner ditolak, non-UTF-8 dibuka hanya-baca (maks. 5 MB) |
| Remote monitoring | Bar di bawah terminal (CPU %, RAM, jaringan ↓/↑, disk, uptime) + panel **Monitor**: grafik CPU & jaringan, memori/swap, semua disk, load, user login, proses teratas. Server Linux |
| SSH tunnel | Local port forwarding (`ssh -L`), mis. buka panel web server di browser HP |
| Network tools | Ping ICMP (cadangan TCP), traceroute, port scanner (banner, progres, stop), scan LAN, DNS (A/AAAA/MX/TXT/NS/SOA/SRV/CAA/PTR, pilih server), whois, Wake-on-LAN, kalkulator subnet, info jaringan perangkat — tanpa root |
| Autentikasi | Password, keyboard-interactive, private key (ed25519/RSA/ECDSA, dengan passphrase) |
| Keamanan | Verifikasi host key (trust-on-first-use), peringatan jika key server berubah, kelola known hosts |

## Struktur

```
src/                 UI (TypeScript, tanpa framework)
  main.ts            layout, tab, sidebar, extra keys, monitor, dialog host key
  terminal.ts        tab terminal xterm.js <-> shell SSH
  sftp.ts            panel SFTP
  editor.ts          editor teks remote (CodeMirror 6, dimuat saat dibutuhkan)
  monitor.ts         resource monitor (bar + panel)
  chart.ts           grafik garis & meter untuk monitor
  nettools.ts        halaman network tools
  tools.ts           dialog tunnel & known hosts
  profiles.ts        penyimpanan & editor sesi
src-tauri/src/       inti Rust
  ssh.rs             koneksi, autentikasi, shell PTY, exec, verifikasi host key
  sftp.rs            operasi SFTP
  tunnel.rs          local port forwarding
  monitor.rs         ambil & parse data /proc server
  icmp.rs            ping/traceroute ICMP tanpa root
  nettools.rs        ping, traceroute, port scan, scan LAN, DNS, whois, WoL
  known_hosts.rs     penyimpanan host key tepercaya
```

## Menjalankan

Prasyarat: Node.js 20+, Rust stable, dan [prasyarat Tauri](https://v2.tauri.app/start/prerequisites/) untuk platform tujuan.

```bash
npm install
npm run tauri dev          # desktop, untuk pengembangan cepat
```

### Android

Butuh Android Studio (SDK + NDK) dan Java 17.

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
export ANDROID_HOME=$HOME/Android/Sdk NDK_HOME=$ANDROID_HOME/ndk/<versi>
npm run tauri android init
npm run tauri android dev                 # jalankan di emulator / HP (USB debugging)
npm run tauri android build -- --apk      # APK rilis (perlu signing)
```

Tanpa setup lokal: setiap push menjalankan workflow **Android APK** di GitHub Actions. APK debug siap pasang bisa diunduh dari tab *Actions* → run terbaru → *Artifacts* → `basterminal-debug-apk`.

### Build rilis Android (APK bertanda tangan)

APK rilis ditandatangani dengan keystore milik Anda. **Keystore + password wajib disimpan baik-baik**: tanpa keduanya, update aplikasi tidak bisa dipasang di atas versi lama (harus uninstall dulu), dan tidak bisa update di Play Store.

**1. Buat keystore (sekali saja, di komputer Anda)**

Linux / macOS / Git Bash:

```bash
./scripts/create-keystore.sh                # menghasilkan basterminal-release.jks
```

Windows (PowerShell, butuh Java/`keytool`):

```powershell
keytool -genkeypair -v -keystore basterminal-release.jks -alias basterminal -keyalg RSA -keysize 4096 -validity 10000
[Convert]::ToBase64String([IO.File]::ReadAllBytes("basterminal-release.jks")) | Set-Content -NoNewline basterminal-release.jks.base64.txt
```

Jangan pernah commit file `.jks` ke repo (sudah di-`.gitignore`).

**2. Isi GitHub Secrets** — *Settings → Secrets and variables → Actions → New repository secret*:

| Secret | Isi |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | isi file `basterminal-release.jks.base64.txt` |
| `ANDROID_KEYSTORE_PASSWORD` | password keystore |
| `ANDROID_KEY_ALIAS` | `basterminal` |
| `ANDROID_KEY_PASSWORD` | password key (biasanya sama dengan password keystore) |

**3. Build**

- Manual: tab *Actions* → **Android Release** → *Run workflow*. APK ada di *Artifacts* → `basterminal-release-apk`.
- Rilis resmi: naikkan `version` di `src-tauri/tauri.conf.json` (dan `package.json`), lalu push tag:

  ```bash
  git tag v0.1.0 && git push origin v0.1.0
  ```

  APK otomatis dilampirkan ke halaman **Releases** GitHub.

Hasilnya dua APK: `…-arm64.apk` (hampir semua HP modern) dan `…-arm.apk` (HP lama 32-bit). Android menolak memasang update dengan versi yang tidak lebih tinggi, jadi selalu naikkan `version` setiap rilis.

### iOS

Butuh macOS dengan Xcode.

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
npm run tauri ios init
npm run tauri ios dev                     # simulator / iPhone
npm run tauri ios build                   # perlu Apple Developer Team untuk signing
```

Isi `bundle.iOS.developmentTeam` di `src-tauri/tauri.conf.json` dengan Team ID Anda sebelum build ke perangkat.

## Catatan

- **Penyimpanan kredensial**: profil sesi (termasuk password jika "Simpan password" dicentang, dan private key) disimpan di folder data privat aplikasi dalam bentuk teks biasa. Folder ini tidak bisa diakses aplikasi lain, tapi belum dienkripsi. Rencana berikutnya: Android Keystore / iOS Keychain.
- **Download SFTP** disimpan ke `Download/basterminal` bila bisa ditulis; jika tidak, ke folder dokumen/data aplikasi. Path lengkap ditampilkan setelah download.
- **Ping & scan LAN** memakai ICMP tanpa root (Android dan iOS mengizinkan "ping socket"); jika tidak diizinkan, otomatis memakai TCP connect.
- **Traceroute** tersedia di Android dan Linux (IPv4). Di iOS belum didukung.
- **Resource monitor** membaca `/proc` lewat SSH, jadi butuh server Linux. Di server lain bar monitor menampilkan pesan error.
- Di iOS, koneksi SSH akan dijeda sistem saat aplikasi di background.

## Roadmap

- [ ] Kredensial terenkripsi (Keystore/Keychain)
- [ ] Remote & dynamic port forwarding (SOCKS)
- [ ] Jump host / bastion
- [ ] Telnet, serial (USB-OTG), Mosh
- [ ] VNC / RDP viewer
- [ ] Snippet / macro perintah
- [ ] Sinkronisasi folder SFTP dengan direktori terminal
