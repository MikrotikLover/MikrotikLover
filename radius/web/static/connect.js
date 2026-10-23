// Users' Wi-Fi connect guide — phone-style step pictures built from the network's real names.
// Public page (no login). All text is set with textContent.

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// ---- mock screens
const bar = () => h("div", { class: "bar" }, h("span", {}, "9:41"), h("span", {}, "▂▄▆ ●"));
const phone = (kind, ...content) => h("div", { class: "phone" + (kind === "laptop" ? " laptop" : "") }, h("div", { class: "screen" }, bar(), content));
const title = (t) => h("div", { class: "title" }, t);
const row = (label, value, hl = false, cls = "") => h("div", { class: `row ${cls}${hl ? " hl" : ""}` }, h("span", { class: "lbl" }, label), h("span", { class: "val" }, value));
const wifiRow = (name, hl) => row("", name, hl, "wifi");
const buttons = (...b) => h("div", { class: "btns" }, b.map(([t, main, hl]) => h("span", { class: `pbtn${main ? " main" : ""}${hl ? " hl" : ""}` }, t)));
const okScreen = (t) => h("div", { class: "ok" }, h("div", { class: "tick" }, "✓"), h("b", {}, t));
const step = (n, text, small, pic) => h("div", { class: "step" }, h("div", { class: "step-text" }, h("span", { class: "num" }, n),
  h("div", {}, h("p", {}, text), small ? h("small", {}, small) : null)), pic);

let S = { brand: "Wi-Fi", ssid: "Office-WiFi", hotspot_ssid: "Guest-WiFi", hotspot_url: "http://login.wifi", radius_domain: "", contact: "" };
const you = "aap ka username", pass = "••••••••";

const GUIDES = {
  android: {
    label: "Android",
    intro: () => ["Aap ko office se ", h("b", {}, "username aur password"), " mila hoga. Android 11+ ke liye ye steps hain."],
    steps: () => [
      step(1, ["Settings → Wi-Fi kholein aur ", h("code", {}, S.ssid), " par tap karein."], null,
        phone("phone", title("Wi-Fi"), wifiRow("Home-WiFi"), wifiRow(S.ssid, true), wifiRow("Neighbour"))),
      step(2, ["EAP method ", h("code", {}, "PEAP"), ", Phase 2 ", h("code", {}, "MSCHAPV2"), " chunein."],
        "Kuch phones mein \"Advanced options\" kholna parta hai.",
        phone("phone", title(S.ssid), row("EAP method", "PEAP", true), row("Phase 2 auth", "MSCHAPV2", true), row("CA certificate", "Trust on first use"), row("Domain", S.radius_domain || "—"))),
      step(3, ["CA certificate: ", h("b", {}, "Trust on first use"), " (Android 13+). Domain: ", h("code", {}, S.radius_domain || "—")],
        "Android 11–12: neeche diya certificate pehle install karein aur phir usay yahan chunein.",
        phone("phone", title(S.ssid), row("CA certificate", "Trust on first use", true), row("Domain", S.radius_domain || "—", true), row("Identity", you), row("Password", pass))),
      step(4, ["Identity mein apna ", h("b", {}, "username"), " aur Password likhein, phir Connect."], "Anonymous identity khaali chhor dein.",
        phone("phone", title(S.ssid), row("Identity", you, true), row("Anonymous identity", ""), row("Password", pass, true), buttons(["Cancel"], ["Connect", true, true]))),
      step(5, "\"Trust this network?\" aaye to Trust / Connect dabayein. Bas, connected!", null,
        phone("phone", h("div", { class: "dialog" }, h("b", {}, "Trust this network?"), `Server: ${S.radius_domain || S.ssid}`), buttons(["Cancel"], ["Trust", true, true]))),
    ],
    extra: () => certBox(true),
  },
  iphone: {
    label: "iPhone / iPad",
    intro: () => ["iPhone par sirf username aur password chahiye."],
    steps: () => [
      step(1, ["Settings → Wi-Fi mein ", h("code", {}, S.ssid), " par tap karein."], null,
        phone("phone", title("Wi-Fi"), wifiRow("Home-WiFi"), wifiRow(S.ssid, true), wifiRow("Neighbour"))),
      step(2, ["Username aur Password likh kar ", h("b", {}, "Join"), " dabayein."], null,
        phone("phone", title(`Enter password for "${S.ssid}"`), row("Username", you, true), row("Password", pass, true), buttons(["Cancel"], ["Join", true, true]))),
      step(3, ["Certificate screen par ", h("b", {}, "Trust"), " dabayein."], `Certificate ka naam: ${S.radius_domain || "radius server"}`,
        phone("phone", title("Certificate"), h("div", { class: "dialog" }, h("b", {}, S.radius_domain || "radius"), "Not Verified"), buttons(["Cancel"], ["Trust", true, true]))),
      step(4, "Connected! Agli dafa khud jud jayega.", null, phone("phone", okScreen(`Connected to ${S.ssid}`))),
    ],
  },
  windows: {
    label: "Windows",
    intro: () => ["Windows 10 / 11"],
    steps: () => [
      step(1, ["Neeche taskbar mein Wi-Fi icon → ", h("code", {}, S.ssid), " → Connect."], null,
        phone("laptop", title("Wi-Fi"), wifiRow(S.ssid, true), buttons(["Connect", true, true]))),
      step(2, "Username aur password likh kar OK.", null,
        phone("laptop", title("Enter your user name and password"), row("User name", you, true), row("Password", pass, true), buttons(["OK", true, true], ["Cancel"]))),
      step(3, ["\"Continue connecting?\" par ", h("b", {}, "Connect"), "."], "Ye aap ke network ka certificate hai.",
        phone("laptop", h("div", { class: "dialog" }, h("b", {}, "Continue connecting?"), "If you expect to find this network here, go ahead and connect."), buttons(["Connect", true, true], ["Cancel"]))),
    ],
  },
  mac: {
    label: "Mac",
    intro: () => ["macOS"],
    steps: () => [
      step(1, ["Upar menu bar mein Wi-Fi → ", h("code", {}, S.ssid), "."], null, phone("laptop", title("Wi-Fi"), wifiRow(S.ssid, true))),
      step(2, "Username aur password → Join.", null, phone("laptop", title(S.ssid), row("Username", you, true), row("Password", pass, true), buttons(["Cancel"], ["Join", true, true]))),
      step(3, ["Certificate par ", h("b", {}, "Continue"), " (Mac ka password maang sakta hai)."], null,
        phone("laptop", h("div", { class: "dialog" }, h("b", {}, "Verify Certificate"), S.radius_domain || "radius"), buttons(["Cancel"], ["Continue", true, true]))),
    ],
  },
  pppoe: {
    label: "PPPoE router",
    intro: () => ["Ghar / dukaan ke router (TP-Link, Tenda, D-Link...) mein internet ", h("b", {}, "PPPoE"), " se chalayein. Username aur password aap ko connection ke waqt mila hoga."],
    steps: () => [
      step(1, ["Router ko cable se laptop/phone se jorein aur browser mein router ka page kholein (aksar ", h("code", {}, "192.168.0.1"), " ya ", h("code", {}, "192.168.1.1"), ")."], "Router ke neeche sticker par address aur login likha hota hai.",
        phone("laptop", title("Router login"), row("Address", "192.168.0.1", true), row("Username", "admin"), row("Password", pass), buttons(["Login", true]))),
      step(2, ["Internet / WAN settings mein Connection type: ", h("b", {}, "PPPoE"), "."], null,
        phone("laptop", title("WAN / Internet"), row("Connection type", "PPPoE", true), row("Username", ""), row("Password", ""))),
      step(3, ["Apna ", h("b", {}, "username"), " aur ", h("b", {}, "password"), " likhein, Save / Connect."], "MTU khud na badlein (1480 theek hai).",
        phone("laptop", title("WAN / Internet"), row("Connection type", "PPPoE"), row("Username", you, true), row("Password", pass, true), buttons(["Save", true, true]))),
      step(4, "Status mein \"Connected\" aur ek IP aa jaye to internet chal raha hai.", "Package khatam ho to router connect nahi hoga — renew karwa lein.",
        phone("laptop", okScreen("PPPoE connected"), row("IP address", "10.20.x.x"))),
    ],
  },
  hotspot: {
    label: "Hotspot / Voucher",
    intro: () => ["Card (voucher) ya hotspot account wale ", h("b", {}, S.hotspot_ssid), " se judein."],
    steps: () => [
      step(1, ["Wi-Fi mein ", h("code", {}, S.hotspot_ssid), " chunein (password nahi lagta)."], null,
        phone("phone", title("Wi-Fi"), wifiRow(S.hotspot_ssid, true), wifiRow(S.ssid))),
      step(2, ["Login page khud khul jayega. Na khule to browser mein ", h("code", {}, S.hotspot_url), " kholein."], null,
        phone("phone", h("div", { class: "login-card" }, h("div", { class: "brandl" }, S.brand), h("div", { class: "field hl" }, "Username"), h("div", { class: "field hl" }, "Password"), h("div", { class: "go" }, "Login")))),
      step(3, ["Card par likha ", h("b", {}, "User"), " aur ", h("b", {}, "Pass"), " (ya PIN dono jagah) likh kar Login."], "Package pehli login se shuru hota hai.",
        phone("phone", h("div", { class: "login-card" }, h("div", { class: "brandl" }, S.brand), h("div", { class: "field hl" }, "WF7KQ2PA"), h("div", { class: "field hl" }, "482913"), h("div", { class: "go" }, "Login")))),
      step(4, "Bas! Status page par baqi waqt aur data nazar aata hai.", "\"Package expired\" ya \"quota used up\" aaye to naya card lein.",
        phone("phone", okScreen("You are logged in"), row("Time left", "23h 59m"), row("Data left", "1.0 GB"))),
    ],
  },
};

function certBox(android) {
  return h("div", { class: "intro" },
    h("b", {}, "Android 11–12 ke liye certificate: "),
    "ye file download karein → Settings → Security → Encryption & credentials → Install a certificate → ",
    h("b", {}, "Wi-Fi certificate"), " → file chunein → naam likhein (jaise ", h("code", {}, S.brand), "). Phir step 3 mein yahi certificate chunein.",
    h("div", {}, h("a", { class: "dl", href: "/static/ca.der", download: "wifi-ca.der" }, "⬇ Certificate download (ca.der)")),
    android ? null : null);
}

function show(key) {
  const g = GUIDES[key];
  document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.key === key)));
  document.getElementById("guide").replaceChildren(h("div", { class: "intro" }, g.intro()), h("div", { class: "steps" }, g.steps()), g.extra ? g.extra() : null);
  history.replaceState(null, "", `#${key}`);
}

function guess() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "iphone";
  if (/Android/.test(ua)) return "android";
  if (/Windows/.test(ua)) return "windows";
  if (/Macintosh/.test(ua)) return "mac";
  return "android";
}

(async () => {
  try { S = { ...S, ...(await (await fetch("/api/public/connect")).json()) }; } catch { /* defaults */ }
  document.title = `${S.brand} — Wi-Fi se kaise judein`;
  document.getElementById("brand").textContent = S.brand;
  document.getElementById("tabs").replaceChildren(...Object.entries(GUIDES).map(([k, g]) =>
    h("button", { type: "button", "data-key": k, onclick: () => show(k) }, g.label)));
  document.getElementById("help").replaceChildren(h("h2", {}, "Masla ho to"),
    h("ul", {},
      h("li", {}, "Password ya username galat → office se dobara check karein (capital/small letters ka farq hai)."),
      h("li", {}, "\"Can't connect\" / baar baar password maange → network \"Forget\" kar ke dobara steps karein."),
      h("li", {}, ["Android par \"Domain\" bilkul ", h("code", {}, S.radius_domain || "—"), " hona chahiye."]),
      h("li", {}, "Hotspot ka login page na khule → browser mein koi bhi http website kholein, ya upar wala address."),
      S.contact ? h("li", {}, ["Madad: ", h("b", {}, S.contact)]) : null));
  const want = location.hash.slice(1);
  show(GUIDES[want] ? want : guess());
})();
