// SSH tunnels dialog and the known-hosts manager.
import { api } from "./api";
import { errMsg, field, h, modal, toast } from "./ui";

const input = (value: string, attrs: Record<string, string> = {}) =>
  h("input", { value, autocapitalize: "off", autocomplete: "off", spellcheck: "false", ...attrs });

export async function tunnelsDialog(connId: string | null, label: string) {
  if (!connId) return toast("Buka/aktifkan sesi SSH dulu", "error");
  const list = h("div", { class: "tunnel-list" });
  const refresh = async () => {
    const tunnels = await api.tunnelList(connId);
    list.replaceChildren(
      ...(tunnels.length
        ? tunnels.map((t) =>
            h(
              "div",
              { class: "tunnel-row" },
              h("code", {}, `127.0.0.1:${t.localPort} → ${t.remoteHost}:${t.remotePort}`),
              h("span", { class: "muted" }, ` ${t.connections} koneksi `),
              h(
                "button",
                {
                  class: "btn danger small",
                  type: "button",
                  onclick: async () => {
                    await api.tunnelStop(connId, t.id);
                    refresh();
                  },
                },
                "Stop",
              ),
            ),
          )
        : [h("p", { class: "muted" }, "Belum ada tunnel.")]),
    );
  };
  const local = input("8080", { type: "number" });
  const rhost = input("127.0.0.1");
  const rport = input("80", { type: "number" });
  const add = async () => {
    try {
      const t = await api.tunnelStart(connId, Number(local.value), rhost.value.trim(), Number(rport.value));
      toast(`Tunnel aktif di 127.0.0.1:${t.localPort}`, "ok");
      refresh();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const body = h(
    "div",
    { class: "form" },
    h("p", { class: "muted" }, `Local port forwarding (ssh -L) lewat ${label}. Buka http://127.0.0.1:<port> di browser HP.`),
    h(
      "div",
      { class: "row" },
      field("Port lokal", local),
      field("Host tujuan", rhost),
      field("Port tujuan", rport),
    ),
    h("button", { class: "btn primary", type: "button", onclick: add }, "Mulai tunnel"),
    list,
  );
  refresh().catch((e) => toast(errMsg(e), "error"));
  await modal("SSH Tunnel", body, [{ label: "Tutup", value: "close" }]);
}

export async function knownHostsDialog() {
  const list = h("div", { class: "tunnel-list" });
  const refresh = async () => {
    const hosts = await api.knownHostsList();
    const keys = Object.keys(hosts).sort();
    list.replaceChildren(
      ...(keys.length
        ? keys.map((host) =>
            h(
              "div",
              { class: "tunnel-row column" },
              h("strong", {}, host),
              h("code", { class: "fp" }, `${hosts[host].algorithm} ${hosts[host].fingerprint}`),
              h(
                "button",
                {
                  class: "btn danger small",
                  type: "button",
                  onclick: async () => {
                    await api.knownHostsRemove(host);
                    refresh();
                  },
                },
                "Lupakan",
              ),
            ),
          )
        : [h("p", { class: "muted" }, "Belum ada host tepercaya.")]),
    );
  };
  await refresh();
  await modal("Known hosts", list, [{ label: "Tutup", value: "close" }]);
}
