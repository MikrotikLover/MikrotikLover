// End-to-end browser test of the web dashboard (needs a running install).
//   URL=https://127.0.0.1:8443 USER=admin PASS=... SHOTS=/tmp/shots node tests/ui-dashboard.mjs
// Creates ui-* test objects through the UI, checks every page renders without console/CSP errors,
// then deletes the test objects again through the UI.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");

const URL = process.env.URL || "https://127.0.0.1:8443";
const SHOTS = process.env.SHOTS || "";
const errors = [];
let step = "";
let expect400 = false;   // set while a test sends bad input on purpose
const ok = (msg) => console.log(`ok   ${msg}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 }, ...opts });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" && !/401/.test(m.text()) && !(expect400 && /400/.test(m.text()))) errors.push(`[${step}] console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`[${step}] pageerror: ${e.message}`));
  return page;
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
const go = async (page, hash, title) => {
  step = hash;
  await page.goto(`${URL}/${hash}`);
  await page.locator("header h1", { hasText: title }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
};
async function login(page) {
  step = "login";
  await page.goto(URL);
  await page.fill("input[name=username]", process.env.USER || "admin");
  await page.fill("input[name=password]", process.env.PASS);
  await page.click("button[type=submit]");
  await page.locator("header h1", { hasText: "Dashboard" }).waitFor({ timeout: 15000 });
}
const dlgButton = (page, label) => page.locator("dialog[open] .dlg-foot button", { hasText: label });
async function toastText(page) {
  const t = page.locator(".toast").last();
  await t.waitFor({ timeout: 30000 });
  return t.textContent();
}
// click, then wait for a NEW toast (not one left over from an earlier action) and return it
async function clickToast(page, locator) {
  await page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.setAttribute("data-seen", "1")));
  await locator.click();
  const t = page.locator(".toast:not([data-seen])").last();
  await t.waitFor({ timeout: 60000 });
  if (await t.evaluate((el) => el.classList.contains("error"))) throw new Error(`error toast: ${await t.textContent()}`);
  return t.textContent();
}

try {
  const page = await newPage();
  step = "login page";
  await page.goto(URL);
  await page.locator("input[name=username]").waitFor();
  await shot(page, "01-login");
  await login(page);
  ok("login");
  await page.waitForTimeout(800);
  await shot(page, "02-dashboard");

  // group
  await go(page, "#/groups", "Groups");
  await page.click("text=Add group");
  await page.fill("dialog[open] input[name=name]", "ui-group");
  await page.fill("dialog[open] input[name=description]", "Created by the UI test");
  await page.fill("dialog[open] input[name=rate]", "5M/5M");
  await page.fill("dialog[open] input[name=max_sessions]", "2");
  await page.selectOption("dialog[open] select[name=policy]", "students");
  await dlgButton(page, "Save").click();
  console.log("     toast:", (await toastText(page)).trim());
  await page.locator("td", { hasText: "ui-group" }).first().waitFor();
  ok("group created via UI");
  await shot(page, "03-groups");

  // user with generated password
  await go(page, "#/users", "Users");
  await page.click("text=Add user");
  await page.fill("dialog[open] input[name=name]", "ui-user");
  await page.selectOption("dialog[open] select[name=group]", "ui-group");
  await dlgButton(page, "Create user").click();
  const secret = await page.locator("dialog[open] .secret-box").textContent({ timeout: 30000 });
  if (!/^[A-Za-z0-9]{10}$/.test(secret)) throw new Error(`unexpected generated password: ${secret}`);
  ok(`user created, generated password shown (${secret.length} chars)`);
  await dlgButton(page, "Close").click();
  await page.locator("a", { hasText: "ui-user" }).waitFor();
  await shot(page, "04-users");

  // user detail: own policy
  await go(page, "#/users/ui-user", "ui-user");
  const sel = page.locator("label", { hasText: "Own web-filter policy" }).locator("select");
  await sel.selectOption("guests");
  await page.locator("label", { hasText: "Own web-filter policy" }).locator("button", { hasText: "Save" }).click();
  console.log("     toast:", (await toastText(page)).trim());
  await page.locator(".tile", { hasText: "Policy" }).locator(".value", { hasText: "guests" }).waitFor();
  ok("per-user policy set");
  await shot(page, "05-user-detail");

  // MAC device
  await go(page, "#/macs", "MAC devices");
  await page.click("text=Add device");
  await page.fill("dialog[open] input[name=mac]", "02:00:5e:10:20:30");
  await page.fill("dialog[open] input[name=description]", "UI test printer");
  await dlgButton(page, "Add").click();
  await page.locator("code", { hasText: "02-00-5E-10-20-30" }).waitFor({ timeout: 30000 });
  ok("MAC device added");
  await shot(page, "06-macs");

  // router
  await go(page, "#/routers", "Routers");
  await page.click("text=Add router");
  await page.fill("dialog[open] input[name=ip]", "10.99.0.1");
  await page.fill("dialog[open] input[name=name]", "ui-router");
  await dlgButton(page, "Add router").click();
  const cmd = await page.locator("dialog[open] .secret-box").textContent({ timeout: 60000 });
  if (!cmd.includes("/radius add")) throw new Error("router command not shown");
  ok("router added, MikroTik command shown");
  await shot(page, "07-router-added");
  await dlgButton(page, "Close").click();

  // hotspot business: plan -> vouchers -> print -> subscription -> sales
  await go(page, "#/plans", "Plans");
  await page.click("text=New plan");
  await page.fill("dialog[open] input[name=name]", "ui-day");
  await page.fill("dialog[open] input[name=price]", "50");
  await page.fill("dialog[open] input[name=validity]", "1d");
  await page.fill("dialog[open] input[name=quota]", "1G");
  await page.fill("dialog[open] input[name=rate]", "4M/4M");
  await page.fill("dialog[open] input[name=description]", "1 day, 1 GB, 4 Mbps");
  await page.fill("dialog[open] input[name=fup]", "1M/1M");
  await dlgButton(page, "Save").click();
  await page.locator("td", { hasText: "ui-day" }).first().waitFor({ timeout: 30000 });
  await page.locator("tr", { hasText: "ui-day" }).locator("td", { hasText: "then 1M/1M" }).first().waitFor();
  ok("plan created (with FUP speed)");
  await shot(page, "17-plans");
  await page.locator("tr", { hasText: "ui-day" }).locator("button", { hasText: "Vouchers" }).click();
  await page.locator("dialog[open] input[name=count]").waitFor();
  await page.fill("dialog[open] input[name=count]", "12");
  await page.fill("dialog[open] input[name=prefix]", "UI");
  await dlgButton(page, "Create").click();
  await page.locator("header h1", { hasText: "Voucher batch" }).waitFor({ timeout: 60000 });
  const codes = await page.locator("tbody code").count();
  if (codes !== 24) throw new Error(`expected 12 vouchers (24 code cells), got ${codes}`);
  ok("12 vouchers created");
  await shot(page, "18-voucher-batch");
  const batchUrl = page.url();
  await page.click("text=Print cards");
  await page.locator(".vcard").first().waitFor();
  if ((await page.locator(".vcard").count()) !== 12) throw new Error("print page card count");
  await page.waitForTimeout(300);
  await shot(page, "19-voucher-print");
  ok("print page: 12 cards");

  await go(page, "#/users/ali", "ali");
  const pkg = page.locator(".card", { hasText: "Package" });
  await pkg.locator("select").selectOption("ui-day");
  console.log("     toast:", (await clickToast(page, pkg.locator("button", { hasText: "Set plan" }))).trim());
  await page.locator(".card", { hasText: "Package" }).locator("button", { hasText: "Renew" }).waitFor();
  console.log("     toast:", (await clickToast(page, page.locator(".card", { hasText: "Package" }).locator("button", { hasText: "Renew" }))).trim());
  await page.waitForTimeout(800);
  await shot(page, "20-user-package");
  ok("user plan + renew");

  await go(page, "#/sales", "Sales");
  await shot(page, "21-sales");
  ok("sales page");
  await go(page, "#/data/usersites", "Data usage");
  await page.locator(".hbars, .empty").first().waitFor();
  if (await page.locator("text=[object Object]").count()) throw new Error("user-sites shows [object Object]");
  await shot(page, "22-user-top-sites");
  ok("per-user top sites");

  // PPPoE static IP on the user page
  await go(page, "#/users/ali", "ali");
  const ipLabel = page.locator("label", { hasText: "Static IP (PPPoE)" });
  await ipLabel.locator("input").fill("10.20.0.77");
  console.log("     toast:", (await clickToast(page, ipLabel.locator("button", { hasText: "Save" }))).trim());
  await page.locator("td", { hasText: "10.20.0.77" }).waitFor();
  await page.locator("label", { hasText: "Static IP (PPPoE)" }).locator("input").fill("");
  await clickToast(page, page.locator("label", { hasText: "Static IP (PPPoE)" }).locator("button", { hasText: "Save" }));
  ok("PPPoE static IP set and cleared");

  // CDN detective
  await go(page, "#/cdn", "CDN detective");
  await page.fill("input[type=search]", "rr3---sn-4g5e6nsz.googlevideo.com");
  await page.click("button:has-text('Investigate')");
  await page.locator(".tile .value", { hasText: "YouTube" }).waitFor({ timeout: 30000 });
  ok("detective: googlevideo -> YouTube");
  await page.fill("input[type=search]", "157.240.1.35");
  await page.locator("form button:has-text('Investigate')").click();
  await page.locator(".tile .value", { hasText: "Facebook" }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(300);
  await shot(page, "26-cdn-detective");
  ok("detective: Meta IP -> Facebook (DNS evidence)");

  // auto-learned app domain lists
  const tiktok = page.locator("details", { has: page.locator("summary b", { hasText: /^TikTok$/ }) });
  await tiktok.locator("summary").click();
  await tiktok.locator("td code", { hasText: "tiktokcdn-new.net" }).waitFor({ timeout: 15000 });
  if (!(await tiktok.locator(".badge", { hasText: "learned" }).count())) throw new Error("learned badge missing");
  const rsc = await page.request.get(`${URL}/api/cdn/rsc?app=TikTok`);
  const body = await rsc.text();
  if (rsc.status() !== 200 || !body.includes("name=tiktokcdn-new.net")) throw new Error("RouterOS export missing learned domain");
  console.log("     toast:", (await clickToast(page, page.locator("button", { hasText: "Learn now" }))).trim());
  await page.waitForTimeout(500);
  await tiktok.scrollIntoViewIfNeeded();
  await shot(page, "28-app-domain-lists");
  ok("app domain lists: learned TikTok domain, RouterOS export, Learn now");

  // newly discovered apps (only when the server has found one)
  const disc = page.locator("details", { has: page.locator("summary .badge", { hasText: /^(new|discovered)$/ }) }).first();
  if (await disc.count()) {
    await disc.locator("summary").click();
    await disc.locator("button", { hasText: "Rename" }).click();
    await page.fill("dialog[open] input[name=name]", "Zing Clips");
    await page.fill("dialog[open] input[name=category]", "video");
    await dlgButton(page, "Save").click();
    await page.locator("details summary b", { hasText: /^Zing Clips$/ }).waitFor({ timeout: 30000 });
    await page.waitForTimeout(400);
    await page.locator("details summary b", { hasText: /^Zing Clips$/ }).scrollIntoViewIfNeeded();
    await shot(page, "29-discovered-app");
    ok("discovered app renamed in the dashboard");
  } else console.log("     (no discovered app on this server — skipped)");

  // ports & protocols
  // the test data may be some days old: look at the last 30 days
  const ports30 = async (hash) => {
    await go(page, hash, "Ports & protocols");
    await page.locator(".toolbar select").first().selectOption("30");
    await page.getByRole("button", { name: "Show", exact: true }).click();
  };
  await ports30("#/ports/port");
  await page.locator("code", { hasText: "443/udp" }).first().waitFor({ timeout: 15000 });
  await shot(page, "30-ports");
  await ports30("#/ports/in");
  await page.locator("code", { hasText: "37777/tcp" }).first().waitFor({ timeout: 15000 });
  await go(page, "#/ports/profile", "Ports & protocols");
  await page.locator("h2", { hasText: "whatsapp.com" }).first().waitFor({ timeout: 15000 });
  await shot(page, "31-app-port-profiles");
  ok("ports & protocols: top ports, inbound, saved app profiles");

  // apps on the network (automatic inventory)
  await go(page, "#/apps", "Apps on network");
  const waRow = page.locator("tr", { has: page.locator("b", { hasText: /^WhatsApp$/ }) }).first();
  if (await waRow.count()) {
    await shot(page, "32-apps");
    await waRow.getByRole("link", { name: "Details", exact: true }).click();
    await page.locator("header h1", { hasText: "WhatsApp" }).waitFor({ timeout: 15000 });
    for (const t of ["Ports and protocols", "Server addresses", "Names (domains and subdomains)", "Devices that use it"])
      await page.locator(".card h2", { hasText: t }).waitFor({ timeout: 15000 });
    await shot(page, "33-app-detail");
    await go(page, "#/apps", "Apps on network");
    await page.locator(".subtabs a", { hasText: /^Android/ }).click();
    await page.locator(".subtabs a.active", { hasText: /^Android/ }).waitFor({ timeout: 15000 });
    await go(page, "#/apps/video", "Apps on network");
    await page.locator(".tabs a.active", { hasText: /^video/ }).waitFor({ timeout: 15000 });
    ok("apps on network: list, app details (ports, servers, names, devices), Android filter, category filter");
  } else console.log("     (no app inventory on this server — skipped)");

  // blocking: make a policy in the editor, give it to a user, WhatsApp only, router script, delete
  await go(page, "#/blocking", "Blocking");
  await page.locator(".attn, .quick").first().waitFor({ timeout: 15000 });
  ok("blocking overview: numbers, what waits, quick actions");
  const wu = page.locator(".card", { hasText: "Windows Update" }).first();
  await wu.waitFor({ timeout: 15000 });
  for (const b of ["Allowed", "Off in office hours", "Off always"]) await wu.getByRole("button", { name: b, exact: true }).waitFor();
  ok("blocking overview: Windows Update switch (allowed / office hours / always)");
  await go(page, "#/blocking/policies", "Blocking");
  await page.getByRole("button", { name: "+ New policy" }).click();
  const ed = page.locator("dialog[open]");
  await ed.locator("input[name=name]").fill("ui-kids");
  await ed.locator("label.check", { hasText: /^social-video/ }).click();
  await ed.locator("label.check", { hasText: /^Block VPN/ }).click();
  await ed.locator("input[placeholder^='Search apps']").fill("pubg");
  await ed.locator("label.chip", { hasText: "PUBG Mobile" }).click();
  // every rule has its own time (policy editor): office hours for all three here
  for (const r of [ed.locator(".rule-row", { has: page.locator('b:text-is("social-video")') }), ed.locator(".rule-row", { has: page.locator('b:text-is("Block VPN")') }),
    ed.locator(".rule-row.item", { hasText: "PUBG Mobile" })])
    await r.locator("select.tp-sel").selectOption({ label: "Office hours (9–17, Mon–Sat)" });
  const policyText = await ed.locator("pre.code-box").textContent();
  for (const want of ["block social-video time=9h-17h,mon,tue,wed,thu,fri,sat", "block-app PUBG Mobile time=9h-17h", "block-vpn time=9h-17h"])
    if (!policyText.includes(want)) throw new Error(`policy text misses "${want}":\n${policyText}`);
  await shot(page, "40-policy-editor");
  await clickToast(page, dlgButton(page, "Save policy"));
  const kidsCard = page.locator('.policy-row[data-name="ui-kids"]');
  await kidsCard.waitFor({ timeout: 30000 });
  await kidsCard.getByRole("button", { name: "Give", exact: true }).click();
  await page.locator("dialog[open] input[list=bl-users]").fill("ui-user");
  if (await page.locator("dialog[open] #bl-pol").inputValue() !== "ui-kids") throw new Error("give dialog: the row's policy not chosen");
  await clickToast(page, dlgButton(page, "Apply"));
  await kidsCard.locator("td.pol-used-td", { hasText: "ui-user" }).waitFor({ timeout: 30000 });
  ok("blocking: policy made in the editor (category + app + VPN + time) and given to a user");
  await page.locator(".page-head").getByRole("button", { name: "Give a policy" }).click();
  await page.locator("dialog[open] input[list=bl-users]").fill("ui-user");
  await page.locator("dialog[open] #bl-pol").selectOption("whatsapp-only");
  await clickToast(page, dlgButton(page, "Apply"));
  await page.locator('.policy-row[data-name="whatsapp-only"] td.pol-used-td', { hasText: "ui-user" }).waitFor({ timeout: 30000 });
  await page.locator(".page-head input[type=search]").fill("whatsapp");
  if (await page.locator('.policy-row[data-name="guests"]').isVisible()) throw new Error("policy search: other policies still shown");
  await page.locator(".page-head input[type=search]").fill("");
  ok("blocking: WhatsApp-only given to a user");
  await go(page, "#/blocking/overview", "Blocking");
  await page.locator("input[placeholder^='server IP']").fill("192.168.88.10");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "⬇ Download router script" }).click()]);
  const syncRsc = require("fs").readFileSync(await dl.path(), "utf8");
  if (!syncRsc.includes("/api/public/router") || syncRsc.includes("PUT-THE-KEY-HERE") || !syncRsc.includes("address=192.168.88.10"))
    throw new Error("router auto-sync script not filled in");
  ok("router auto-sync script downloaded with server, IP and key");
  await go(page, "#/blocking/policies", "Blocking");
  await kidsCard.getByRole("button", { name: "Delete" }).click();
  await clickToast(page, dlgButton(page, "Confirm"));
  await kidsCard.waitFor({ state: "detached", timeout: 30000 });
  ok("unused policy deleted");

  // VPN watch
  for (const tab of ["users", "attempts", "servers", "names", "howto"]) {
    await go(page, `#/vpn/${tab}`, "VPN & proxy watch");
    await page.locator(".tile").first().waitFor({ timeout: 15000 });
  }
  await shot(page, "41-vpn-watch");
  ok("VPN watch: who tried, attempts, server + name lists, how to block");

  // security detective, website names, blocking logs
  for (const tab of ["all", "virus", "attack", "ddos", "setup"]) {
    await go(page, `#/security/${tab}`, "Security");
    await page.locator(".tile").first().waitFor({ timeout: 15000 });
  }
  await shot(page, "42-security");
  await go(page, "#/security/ransomware", "Security");
  await page.locator(".health-hero").waitFor({ timeout: 15000 });
  for (const t of ["Devices with signs", "What to do", "Protection", "Ransomware signs"]) await page.locator(".card h2", { hasText: t }).first().waitFor({ timeout: 15000 });
  await shot(page, "42b-ransomware");
  await go(page, "#/security/inbound", "Security");
  for (const t of ["Open doors on the routers", "Who came in from outside", "Outside addresses"]) await page.locator(".card h2", { hasText: t }).first().waitFor({ timeout: 15000 });
  await shot(page, "42c-from-outside");
  ok("security: from outside (open doors, who came in, outside addresses)");

  // intrusion prevention page (works with or without Suricata installed)
  await go(page, "#/security/ips", "Security");
  await page.locator(".health-hero").waitFor({ timeout: 30000 });
  await page.locator(".card h2", { hasText: "Protection" }).waitFor();
  ok("security: intrusion prevention (status, protection, alerts)");
  await go(page, "#/mail", "Mail server");
  await page.locator(".card h2", { hasText: /Your mail server|Checks/ }).first().waitFor({ timeout: 30000 });
  ok("mail server page (set-up form or checks)");

  // step by step: the steps page, then give a policy to a network (no login) and remove it again
  await go(page, "#/golive", "Setup steps");
  await page.locator("details.gl-step").first().waitFor({ timeout: 15000 });
  if (await page.locator("details.gl-step").count() !== 5) throw new Error("setup steps: expected 5 steps");
  await page.locator("details.gl-step[open] h3", { hasText: "Check it works" }).first().waitFor();
  await shot(page, "45-golive");
  await go(page, "#/blocking/policies/givenet/guests", "Blocking");
  const gd = page.locator("dialog[open]");
  await gd.locator("input[name=target]").waitFor();
  await gd.locator("input[name=target]").fill("10.124.3.0/24");
  await gd.locator("input[name=comment]").fill("ui-net-test");
  await clickToast(page, dlgButton(page, "Apply"));
  const ncard = page.locator(".card", { has: page.locator("h2", { hasText: "Networks and IPs with a policy" }) });
  const nrow = ncard.locator("tr", { hasText: "10.124.3.0/24" });
  await nrow.waitFor({ timeout: 15000 });
  await nrow.getByRole("button", { name: "Remove" }).click();
  await clickToast(page, dlgButton(page, "Remove"));
  await page.waitForTimeout(800);
  if (await ncard.locator("tr", { hasText: "10.124.3.0/24" }).count()) throw new Error("network policy not removed");
  ok("setup steps page (5 steps, checks) + policy for a network: given in the dialog, removed");

  // devices (SNMP): list, add dialog with a test against an address that does not answer, traps and settings tabs, a device page
  await go(page, "#/devices", "Devices");
  await page.locator(".health-hero").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "+ Add device" }).click();
  const dd = page.locator("dialog[open]");
  await dd.locator("input[name=ip]").fill("127.0.0.250");
  await dd.locator("select[name=version]").selectOption("3");
  if (!(await dd.locator("input[name=authpass]").isVisible()) || await dd.locator("input[name=community]").isVisible()) throw new Error("devices: v3 fields not shown");
  await dd.locator("select[name=version]").selectOption("2c");
  await dd.locator("input[name=community]").fill("nobody-here");
  await dlgButton(page, "Test").click();
  await dd.locator(".badge", { hasText: "no answer" }).waitFor({ timeout: 20000 });
  await shot(page, "46-device-add");
  await dlgButton(page, "Cancel").click();
  await go(page, "#/devices/traps", "Devices");
  await page.locator(".card h2", { hasText: "Traps" }).waitFor();
  await go(page, "#/devices/settings", "Devices");
  await page.locator(".card h2", { hasText: "Trap receiver" }).waitFor();
  if ((await page.locator(".card", { hasText: "When to alert" }).locator("input[type=number]").count()) !== 5) throw new Error("devices: 5 alert limits expected");
  const firstDev = await page.evaluate(async () => { const r = await fetch("/api/devices"); const d = await r.json(); return d.devices.length ? d.devices[0].id : null; });
  if (firstDev) {
    await go(page, `#/devices/${firstDev}`, "Devices");
    await page.locator(".card h2", { hasText: "What happened" }).waitFor();
    await shot(page, "47-device");
  }
  ok("devices (SNMP): list, add dialog (v2c / v3 fields, test: no answer), traps, settings (5 limits), device page");

  // network map: departments (routers on top, a card per department) and the whole network tree
  await go(page, "#/netmap", "Network map");
  await page.locator(".nm-top").waitFor({ timeout: 15000 });
  await page.locator(".nm-grid").waitFor();
  await shot(page, "48-netmap");
  await go(page, "#/netmap/all", "Network map");
  await page.locator(".tp .tp-cloud").waitFor({ timeout: 15000 });
  await page.locator(".tp input, input[type=search]").first().fill("zz-nothing-matches");
  if (await page.locator(".tp .tp-node").count() !== 0) throw new Error("network map: search did not filter the tree");
  await shot(page, "49-netmap-whole");
  ok("network map: departments view, whole network tree, search filters the tree");

  // remember devices: the card on the Hotspot page (switch, days, phones per user, router line)
  await go(page, "#/hotspot", "Hotspot page");
  const rmc = page.locator(".card", { has: page.locator("h2", { hasText: "Remember devices" }) });
  await rmc.waitFor({ timeout: 15000 });
  if ((await rmc.locator("input[type=number]").count()) !== 2 || !(await rmc.locator("pre", { hasText: "login-by=mac" }).count())) throw new Error("remember devices card incomplete");
  ok("hotspot page: remember devices card (switch, days, phones per user, router line)");

  // firewall: a policy made in the dialog (country source picked by search), seen in the router order, looked up, deleted
  await go(page, "#/firewall", "Firewall");
  await page.locator(".health-hero").waitFor({ timeout: 15000 });
  await page.locator(".card h2", { hasText: "Quick start" }).waitFor();
  await go(page, "#/firewall/policies", "Firewall");
  await page.getByRole("button", { name: "+ New policy" }).click();
  const fd = page.locator("dialog[open]");
  await fd.locator("input[name=name]").fill("ui-fw-test");
  await fd.locator("select").first().selectOption("wan");
  await fd.locator("input[type=search]").first().fill("north korea");
  await fd.locator("button.chip", { hasText: "KP · North Korea" }).first().click();
  await fd.locator(".seg button", { hasText: "Reject" }).click();
  await dlgButton(page, "Save policy").click();
  const fwRow = page.locator("tbody tr", { hasText: "ui-fw-test" });
  await fwRow.waitFor({ timeout: 30000 });
  if (!(await fwRow.textContent()).includes("KP") || !(await fwRow.textContent()).includes("REJECT")) throw new Error("firewall policy row wrong");
  ok("firewall: new policy from the dialog (country picked by search, reject)");
  await go(page, "#/firewall/lookup", "Firewall");
  await page.locator(".fw-lookup select").first().selectOption("router");
  await page.fill(".fw-lookup input >> nth=0", "175.45.176.9");
  await page.fill(".fw-lookup input >> nth=1", "203.0.113.1");
  await page.locator(".fw-lookup button.primary").click();
  await page.locator(".hh-title").waitFor({ timeout: 15000 });
  ok("firewall: policy lookup answers");
  await go(page, "#/firewall/policies", "Firewall");
  await page.locator("tbody tr", { hasText: "ui-fw-test" }).getByRole("button", { name: "delete" }).click();
  await dlgButton(page, "Yes").click();
  await page.locator("tbody tr", { hasText: "ui-fw-test" }).waitFor({ state: "detached", timeout: 30000 });
  for (const t of ["addresses", "services", "schedules", "vips", "countries", "logs"]) { await go(page, `#/firewall/${t}`, "Firewall"); await page.locator(".card").first().waitFor(); }
  await shot(page, "42d-firewall");
  ok("firewall: policy deleted; addresses, services, schedules, port forwards, countries, logs pages");
  ok("security: all alerts, virus, hacker attacks, DDoS, protection & lists");
  await go(page, "#/domains", "Website names");
  await page.locator(".tile").first().waitFor({ timeout: 15000 });
  const firstDomain = page.locator(".card table tbody tr a").first();
  if (await firstDomain.count()) {
    await firstDomain.click();
    await page.locator("dialog[open] table").waitFor({ timeout: 15000 });
    await dlgButton(page, "Close").click();
  }
  ok("website names: domains + subdomain list");
  await go(page, "#/blocking/logs", "Blocking");
  await page.locator("h2", { hasText: "Who is blocked by which policy" }).waitFor({ timeout: 30000 });
  ok("blocking logs: policy per user");
  await go(page, "#/settings", "Settings");
  await page.locator("h2", { hasText: /^Backups/ }).waitFor({ timeout: 15000 });
  await clickToast(page, page.getByRole("button", { name: "Backup now", exact: true }));
  // the page is drawn again after the backup: wait for that, or the next step types into a form that is replaced
  await page.waitForLoadState("networkidle"); await page.waitForTimeout(500);
  await page.locator("h2", { hasText: "Automatic updates" }).waitFor({ timeout: 30000 });
  ok("settings: backup made from the dashboard, automatic updates listed");
  {
    const oc = page.locator(".card", { has: page.locator("h2", { hasText: "Off-site copy" }) });
    await oc.waitFor({ timeout: 30000 });
    // the form always offers SSH and rclone; the port field is only for SSH
    await oc.locator("select[name=type]").selectOption("rclone");
    if (!(await oc.locator(".port").isHidden())) throw new Error("off-site: SSH port shown for rclone");
    await oc.locator("select[name=type]").selectOption("ssh");
    if (await oc.locator(".port").isHidden()) throw new Error("off-site: SSH port hidden for SSH");
    await oc.locator("input[name=target]").fill("bad target;x");
    await page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.setAttribute("data-seen", "1")));
    expect400 = true;
    await oc.getByRole("button", { name: /^(Save|Turn on)$/ }).click();
    const bt = page.locator(".toast:not([data-seen])").last();
    await bt.waitFor({ timeout: 15000 });
    if (!/invalid target/.test(await bt.textContent())) throw new Error(`off-site: bad target not refused: ${await bt.textContent()}`);
    expect400 = false;
  }
  ok("settings: off-site copy form (SSH / cloud), bad target refused");
  {
    await page.goto(`${URL}/#/blocking`); await page.waitForTimeout(500);
    await go(page, "#/settings", "Settings");
    const ac = page.locator(".card", { has: page.locator("h2", { hasText: /^Alerts/ }) });
    await ac.waitFor({ timeout: 30000 });
    await page.waitForLoadState("networkidle");
    if ((await ac.locator(".alert-events input[type=checkbox]").count()) !== 15) throw new Error("alerts: 15 event switches expected");
    for (const ch of ["Telegram", "WhatsApp", "Email"]) await ac.locator(".sub-card", { hasText: ch }).first().waitFor();
    if (/AAFake|SmtpPass/.test(await page.content())) throw new Error("alerts: a secret reached the browser");
    await ac.locator("input[name=WHATSAPP_PHONE]").fill("12ab");
    await page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.setAttribute("data-seen", "1")));
    expect400 = true;
    await ac.getByRole("button", { name: "Save", exact: true }).click();
    const at = page.locator(".toast:not([data-seen])").last();
    await at.waitFor({ timeout: 15000 });
    if (!/invalid WHATSAPP_PHONE/.test(await at.textContent())) throw new Error(`alerts: bad phone not refused: ${await at.textContent()}`);
    expect400 = false;
  }
  ok("settings: alerts card (Telegram / WhatsApp / email, 15 events), no secrets in page, bad phone refused");
  {
    const nc = page.locator(".card", { has: page.locator("h2", { hasText: "Warn users before it runs out" }) });
    await nc.waitFor({ timeout: 30000 });
    for (const n of ["notice_days", "notice_quota_pct", "notice_expiry", "notice_quota", "notice_hours"]) await nc.locator(`[name=${n}]`).waitFor();
  }
  ok("settings: warn-users card (days, %, messages, SMS)");

  // business settings
  await go(page, "#/settings", "Settings");
  await page.fill("input[name=brand]", "Lover Net WiFi");
  await page.fill("input[name=hotspot_ssid]", "LoverNet-Guest");
  await page.fill("input[name=contact]", "0300-1234567");
  console.log("     toast:", (await clickToast(page, page.locator(".card", { hasText: "Business & branding" }).locator("button", { hasText: "Save" }))).trim());
  ok("business settings saved");

  // public connect guide (no login, phone)
  const guest = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36" });
  const gp = await guest.newPage();
  gp.on("pageerror", (e) => errors.push(`[connect] pageerror: ${e.message}`));
  gp.on("console", (m) => { if (m.type() === "error") errors.push(`[connect] console: ${m.text()}`); });
  step = "connect";
  await gp.goto(`${URL}/connect`);
  await gp.locator("#brand", { hasText: "Lover Net WiFi" }).waitFor();
  await gp.locator(".step").first().waitFor();
  if (!(await gp.locator("button[aria-pressed=true]", { hasText: "Android" }).count())) throw new Error("Android tab not auto-selected");
  await shot(gp, "23-connect-android");
  await gp.click("button:has-text('Hotspot')");
  await gp.locator("code", { hasText: "LoverNet-Guest" }).first().waitFor();
  await shot(gp, "24-connect-hotspot");
  await gp.click("button:has-text('iPhone')");
  await shot(gp, "25-connect-iphone");
  await gp.click("button:has-text('PPPoE router')");
  await gp.locator(".step").first().waitFor();
  await shot(gp, "27-connect-pppoe");
  ok("public connect guide (Android auto-detected, hotspot, iPhone)");

  // cleanup business objects
  await page.goto(batchUrl);
  await page.locator("header h1", { hasText: "Voucher batch" }).waitFor();
  await page.click("button:has-text('Delete unused')");
  await dlgButton(page, "Delete").click();
  await page.locator("header h1", { hasText: "Vouchers" }).waitFor({ timeout: 30000 });
  await go(page, "#/users/ali", "ali");
  await page.locator(".card", { hasText: "Package" }).locator("select").selectOption("");
  await clickToast(page, page.locator(".card", { hasText: "Package" }).locator("button", { hasText: "Set plan" }));
  await go(page, "#/plans", "Plans");
  await page.locator("tr", { hasText: "ui-day" }).locator("button", { hasText: "Delete" }).click();
  await dlgButton(page, "Delete").click();
  await page.locator("td", { hasText: "ui-day" }).waitFor({ state: "detached", timeout: 30000 });
  ok("business cleanup via UI");

  for (const [hash, title, name] of [["#/online", "Online", "08-online"], ["#/live", "Live log", "09-live"],
    ["#/reports/sites", "Reports", "10-reports-sites"], ["#/reports/blocked", "Reports", "11-reports-blocked"],
    ["#/data/site", "Data usage", "12-data-site"], ["#/data/ip", "Data usage", "13-data-ip"],
    ["#/settings", "Settings", "14-settings"], ["#/health", "Health check", "14b-health"], ["#/speed", "Speed schedule", "14c-speed"], ["#/insights", "Insights", "14d-insights"], ["#/security/reports", "Security", "14e-security-reports"], ["#/hotspot", "Hotspot page", "14f-hotspot"], ["#/blocking/parental", "Blocking", "14g-parental"], ["#/social", "Social WiFi", "14h-social"], ["#/setup", "Router setup", "14i-router-setup"], ["#/ipbind", "IP binding", "14j-ipbind"], ["#/traffic", "Traffic graphs", "14k-traffic"], ["#/departments", "Departments", "14l-departments"], ["#/blocking/why/facebook.com/kid1", "Blocking", "14m-why-blocked"], ["#/blocking/why/XVR6JW", "Blocking", "14n-block-code"], ["#/blocking/requests", "Blocking", "14o-requests"], ["#/blocking/apps", "Blocking", "14p-app-profiles"], ["#/blocking/web", "Blocking", "14q-allowed-websites"], ["#/blocking/guide", "Blocking", "14r-blocking-guide"], ["#/blocking/overview", "Blocking", "14s-blocking-overview"]]) {
    await go(page, hash, title);
    if (hash === "#/health") { await page.locator(".health-hero").waitFor({ timeout: 60000 }); await page.locator(".health-row").first().waitFor({ timeout: 60000 }); }
    if (hash === "#/insights") await page.locator(".insight-words li").first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(700);
    await shot(page, name);
    ok(`page ${hash}`);
  }

  // mobile + dark
  const mobile = await newPage({ viewport: { width: 390, height: 844 }, colorScheme: "dark", isMobile: true });
  await login(mobile);
  await mobile.waitForTimeout(800);
  await shot(mobile, "15-mobile-dark-dashboard");
  await mobile.click("button.menu-btn");
  await mobile.waitForTimeout(400);
  await shot(mobile, "16-mobile-menu");
  ok("mobile + dark mode");

  // cleanup through the UI (exercises delete + confirm dialogs)
  await go(page, "#/users/ui-user", "ui-user");
  await page.click("button.danger:has-text('Delete')");
  await dlgButton(page, "Delete").click();
  await page.waitForURL(/#\/users$/);
  await go(page, "#/groups", "Groups");
  await page.locator("tr", { hasText: "ui-group" }).locator("button", { hasText: "Delete" }).click();
  await dlgButton(page, "Delete").click();
  await page.locator("td", { hasText: "ui-group" }).waitFor({ state: "detached", timeout: 30000 });
  await go(page, "#/macs", "MAC devices");
  await page.locator("tr", { hasText: "02-00-5E-10-20-30" }).locator("button", { hasText: "Remove" }).click();
  await dlgButton(page, "Remove").click();
  await page.locator("code", { hasText: "02-00-5E-10-20-30" }).waitFor({ state: "detached", timeout: 30000 });
  await go(page, "#/routers", "Routers");
  await page.locator("tr", { hasText: "10.99.0.1" }).locator("button", { hasText: "Remove" }).click();
  await dlgButton(page, "Remove").click();
  await page.locator("code", { hasText: "10.99.0.1" }).waitFor({ state: "detached", timeout: 60000 });
  ok("cleanup via UI (delete user, group, MAC, router)");
} catch (e) {
  errors.push(`[${step}] ${e.message.split("\n")[0]}`);
}
await browser.close();
if (errors.length) { console.log("FAIL\n" + errors.join("\n")); process.exit(1); }
console.log("all UI checks passed, no console/CSP errors");
