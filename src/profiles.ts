// Saved SSH session profiles (the "Sessions" list, like MobaXterm's session manager).
import { api } from "./api";
import { field, h, modal } from "./ui";

export interface Profile {
  id: string;
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  password?: string;
  savePassword: boolean;
  privateKey?: string;
  passphrase?: string;
  color: string;
}

const COLORS = ["#2f81f7", "#3fb950", "#d29922", "#f85149", "#a371f7", "#39c5cf", "#db61a2"];

let profiles: Profile[] = [];
const listeners = new Set<() => void>();

export function onProfilesChanged(fn: () => void) {
  listeners.add(fn);
}

export async function loadProfiles() {
  const data = await api.profilesLoad();
  profiles = Array.isArray(data) ? (data as Profile[]) : [];
  listeners.forEach((f) => f());
}

export function getProfiles() {
  return profiles;
}

async function persist() {
  await api.profilesSave(profiles);
  listeners.forEach((f) => f());
}

export async function upsertProfile(p: Profile) {
  const i = profiles.findIndex((x) => x.id === p.id);
  if (i >= 0) profiles[i] = p;
  else profiles.push(p);
  await persist();
}

export async function deleteProfile(id: string) {
  profiles = profiles.filter((p) => p.id !== id);
  await persist();
}

export function newProfile(): Profile {
  return {
    id: crypto.randomUUID(),
    name: "",
    group: "",
    host: "",
    port: 22,
    username: "root",
    authType: "password",
    savePassword: false,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  };
}

/** Session editor dialog. Resolves with the edited profile, or null when cancelled. */
export async function editProfileDialog(initial: Profile, title = "Sesi SSH"): Promise<Profile | null> {
  const p = { ...initial };
  const inp = (value: string, attrs: Record<string, string> = {}) =>
    h("input", { value, autocapitalize: "off", autocomplete: "off", spellcheck: "false", ...attrs });

  const name = inp(p.name, { placeholder: "opsional" });
  const group = inp(p.group, { placeholder: "mis. Produksi" });
  const host = inp(p.host, { placeholder: "192.168.1.10 atau server.com", required: "" });
  const port = inp(String(p.port), { type: "number", min: "1", max: "65535" });
  const user = inp(p.username);
  const auth = h(
    "select",
    {},
    h("option", { value: "password" }, "Password"),
    h("option", { value: "key" }, "Private key"),
  );
  auth.value = p.authType;
  const password = inp(p.password ?? "", { type: "password", placeholder: "kosongkan untuk ditanya saat connect" });
  const save = h("input", { type: "checkbox", checked: p.savePassword });
  const key = h("textarea", {
    rows: 5,
    placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----",
    spellcheck: "false",
    autocapitalize: "off",
  });
  key.value = p.privateKey ?? "";
  const keyFile = h("input", { type: "file" });
  keyFile.addEventListener("change", async () => {
    const f = keyFile.files?.[0];
    if (f) key.value = await f.text();
  });
  const passphrase = inp(p.passphrase ?? "", { type: "password", placeholder: "jika key terenkripsi" });
  const color = inp(p.color, { type: "color" });

  const pwBlock = h(
    "div",
    {},
    field("Password", password),
    h("label", { class: "check" }, save, "Simpan password di perangkat"),
  );
  const keyBlock = h(
    "div",
    {},
    field("Private key (OpenSSH / PEM)", key),
    field("…atau pilih file key", keyFile),
    field("Passphrase", passphrase),
  );
  const sync = () => {
    keyBlock.hidden = auth.value !== "key";
  };
  auth.addEventListener("change", sync);
  sync();

  const body = h(
    "div",
    { class: "form" },
    h("div", { class: "row" }, field("Host", host), h("div", { class: "narrow" }, field("Port", port))),
    field("Username", user),
    field("Autentikasi", auth),
    keyBlock,
    pwBlock,
    h("div", { class: "row" }, field("Nama sesi", name), field("Grup", group)),
    field("Warna", color),
  );

  for (;;) {
    const res = await modal(title, body, [
      { label: "Batal", value: "cancel" },
      { label: "Simpan", value: "save", primary: true },
    ]);
    if (res !== "save") return null;
    if (!host.value.trim()) continue;
    p.host = host.value.trim();
    p.port = Number(port.value) || 22;
    p.username = user.value.trim() || "root";
    p.authType = auth.value as Profile["authType"];
    p.savePassword = save.checked;
    p.password = save.checked ? password.value : undefined;
    p.privateKey = p.authType === "key" ? key.value : undefined;
    p.passphrase = p.authType === "key" && passphrase.value ? passphrase.value : undefined;
    p.name = name.value.trim() || `${p.username}@${p.host}`;
    p.group = group.value.trim();
    p.color = color.value;
    return p;
  }
}
