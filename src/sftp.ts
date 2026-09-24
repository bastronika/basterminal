// SFTP browser shown in the sidebar for the active SSH tab (like MobaXterm's left panel).
import { api, b64ToBytes, bytesToB64, type SftpEntry } from "./api";
import { confirmDialog, errMsg, h, modal, promptDialog, toast, formatSize } from "./ui";

function perms(mode: number | null) {
  if (mode === null) return "";
  const s = "rwxrwxrwx";
  let out = "";
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? s[i] : "-";
  return out;
}

function parent(path: string) {
  if (path === "/") return "/";
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function joinPath(dir: string, name: string) {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

export class SftpPanel {
  readonly el: HTMLDivElement;
  private list: HTMLDivElement;
  private pathInput: HTMLInputElement;
  private connId: string | null = null;
  private cwd = "";
  /** Last visited directory per connection, so switching tabs keeps position. */
  private cwdByConn = new Map<string, string>();
  private upload: HTMLInputElement;

  constructor() {
    this.pathInput = h("input", {
      class: "sftp-path",
      spellcheck: "false",
      autocapitalize: "off",
      onkeydown: (e: Event) => {
        if ((e as KeyboardEvent).key === "Enter") this.open(this.pathInput.value);
      },
    });
    this.upload = h("input", { type: "file", multiple: true, hidden: true, onchange: () => this.doUpload() });
    const btn = (label: string, title: string, fn: () => void) =>
      h("button", { class: "icon-btn", title, type: "button", onclick: fn }, label);
    this.list = h("div", { class: "sftp-list" });
    this.el = h(
      "div",
      { class: "sftp" },
      h(
        "div",
        { class: "sftp-toolbar" },
        btn("⬆", "Folder induk", () => this.open(parent(this.cwd))),
        btn("⌂", "Home", () => this.open(undefined)),
        btn("⟳", "Refresh", () => this.open(this.cwd)),
        btn("＋", "Folder baru", () => this.mkdir()),
        btn("⇪", "Upload", () => this.upload.click()),
      ),
      this.pathInput,
      this.list,
      this.upload,
    );
    this.setConnection(null);
  }

  setConnection(connId: string | null) {
    if (connId === this.connId) return;
    if (this.connId) this.cwdByConn.set(this.connId, this.cwd);
    this.connId = connId;
    if (!connId) {
      this.cwd = "";
      this.pathInput.value = "";
      this.list.replaceChildren(h("p", { class: "muted pad" }, "Buka sesi SSH untuk menjelajah file lewat SFTP."));
      return;
    }
    this.open(this.cwdByConn.get(connId));
  }

  async open(path: string | undefined) {
    if (!this.connId) return;
    const id = this.connId;
    this.list.replaceChildren(h("p", { class: "muted pad" }, "Memuat…"));
    try {
      const res = await api.sftpList(id, path);
      if (id !== this.connId) return;
      this.cwd = res.path;
      this.pathInput.value = res.path;
      this.render(res.entries);
    } catch (e) {
      this.list.replaceChildren(h("p", { class: "error pad" }, errMsg(e)));
    }
  }

  private render(entries: SftpEntry[]) {
    const rows = entries.map((e) =>
      h(
        "div",
        {
          class: "sftp-row",
          onclick: () => (e.isDir ? this.open(e.path) : this.fileActions(e)),
          oncontextmenu: (ev: Event) => {
            ev.preventDefault();
            this.fileActions(e);
          },
        },
        h("span", { class: "sftp-icon" }, e.isDir ? "📁" : e.isLink ? "🔗" : "📄"),
        h("span", { class: "sftp-name" }, e.name),
        h("span", { class: "sftp-meta" }, e.isDir ? perms(e.permissions) : formatSize(e.size)),
        h(
          "button",
          {
            class: "icon-btn small",
            type: "button",
            title: "Aksi",
            onclick: (ev: Event) => {
              ev.stopPropagation();
              this.fileActions(e);
            },
          },
          "⋮",
        ),
      ),
    );
    this.list.replaceChildren(...(rows.length ? rows : [h("p", { class: "muted pad" }, "(folder kosong)")]));
  }

  private async fileActions(e: SftpEntry) {
    const id = this.connId;
    if (!id) return;
    const buttons = [
      ...(e.isDir ? [] : [{ label: "Download", value: "download" }, { label: "Edit", value: "edit" }]),
      { label: "Rename", value: "rename" },
      { label: "Chmod", value: "chmod" },
      { label: "Hapus", value: "delete", danger: true },
      { label: "Tutup", value: "close" },
    ];
    const info = h(
      "div",
      { class: "file-info" },
      h("code", {}, e.path),
      h("p", { class: "muted" }, `${e.isDir ? "Folder" : formatSize(e.size)} · ${perms(e.permissions)}`),
    );
    const action = await modal(e.name, info, buttons);
    try {
      switch (action) {
        case "download": {
          toast("Mengunduh…");
          const saved = await api.sftpDownload(id, e.path);
          toast(`Tersimpan: ${saved}`, "ok");
          break;
        }
        case "edit":
          await this.edit(e);
          break;
        case "rename": {
          const name = await promptDialog("Rename", "Nama baru", e.name);
          if (name && name !== e.name) {
            await api.sftpRename(id, e.path, joinPath(parent(e.path), name));
            await this.open(this.cwd);
          }
          break;
        }
        case "chmod": {
          const current = e.permissions === null ? "644" : (e.permissions & 0o7777).toString(8);
          const mode = await promptDialog("Chmod", "Mode oktal (mis. 755)", current);
          if (mode && /^[0-7]{3,4}$/.test(mode)) {
            await api.sftpChmod(id, e.path, parseInt(mode, 8));
            await this.open(this.cwd);
          }
          break;
        }
        case "delete":
          if (await confirmDialog("Hapus", `Hapus ${e.isDir ? "folder (harus kosong)" : "file"} ${e.name}?`, true)) {
            await api.sftpRemove(id, e.path, e.isDir);
            await this.open(this.cwd);
          }
          break;
      }
    } catch (err) {
      toast(errMsg(err), "error");
    }
  }

  private async edit(e: SftpEntry) {
    if (e.size > 2 * 1024 * 1024) {
      toast("File terlalu besar untuk editor (maks 2 MB)", "error");
      return;
    }
    const text = new TextDecoder().decode(b64ToBytes(await api.sftpRead(this.connId!, e.path)));
    const area = h("textarea", { class: "editor", spellcheck: "false", autocapitalize: "off" });
    area.value = text;
    const res = await modal(`Edit: ${e.name}`, area, [
      { label: "Batal", value: "cancel" },
      { label: "Simpan", value: "save", primary: true },
    ]);
    if (res === "save" && area.value !== text) {
      await api.sftpWrite(this.connId!, e.path, bytesToB64(new TextEncoder().encode(area.value)));
      toast("Tersimpan", "ok");
      await this.open(this.cwd);
    }
  }

  private async mkdir() {
    if (!this.connId) return;
    const name = await promptDialog("Folder baru", "Nama folder");
    if (!name) return;
    try {
      await api.sftpMkdir(this.connId, joinPath(this.cwd, name));
      await this.open(this.cwd);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }

  private async doUpload() {
    const files = Array.from(this.upload.files ?? []);
    this.upload.value = "";
    if (!this.connId || !files.length) return;
    try {
      for (const f of files) {
        toast(`Upload ${f.name}…`);
        const data = bytesToB64(new Uint8Array(await f.arrayBuffer()));
        await api.sftpWrite(this.connId, joinPath(this.cwd, f.name), data);
      }
      toast(`${files.length} file diupload`, "ok");
      await this.open(this.cwd);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }
}
