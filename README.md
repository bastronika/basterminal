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
| SFTP browser di sidebar | Jelajah folder, upload, download, edit teks, rename, chmod, mkdir, hapus |
| Remote monitoring | Bar CPU load / RAM / disk / uptime server aktif |
| SSH tunnel | Local port forwarding (`ssh -L`), mis. buka panel web server di browser HP |
| Network tools | TCP ping, port scanner, DNS lookup (tanpa root) |
| Autentikasi | Password, keyboard-interactive, private key (ed25519/RSA/ECDSA, dengan passphrase) |
| Keamanan | Verifikasi host key (trust-on-first-use), peringatan jika key server berubah, kelola known hosts |

## Struktur

```
src/                 UI (TypeScript, tanpa framework)
  main.ts            layout, tab, sidebar, extra keys, monitor, dialog host key
  terminal.ts        tab terminal xterm.js <-> shell SSH
  sftp.ts            panel SFTP
  tools.ts           network tools, tunnel, known hosts
  profiles.ts        penyimpanan & editor sesi
src-tauri/src/       inti Rust
  ssh.rs             koneksi, autentikasi, shell PTY, exec, verifikasi host key
  sftp.rs            operasi SFTP
  tunnel.rs          local port forwarding
  nettools.rs        TCP ping, port scan, DNS
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
- **Ping** memakai koneksi TCP karena ICMP butuh root di Android/iOS.
- Di iOS, koneksi SSH akan dijeda sistem saat aplikasi di background.

## Roadmap

- [ ] Kredensial terenkripsi (Keystore/Keychain)
- [ ] Remote & dynamic port forwarding (SOCKS)
- [ ] Jump host / bastion
- [ ] Telnet, serial (USB-OTG), Mosh
- [ ] VNC / RDP viewer
- [ ] Snippet / macro perintah
- [ ] Sinkronisasi folder SFTP dengan direktori terminal
