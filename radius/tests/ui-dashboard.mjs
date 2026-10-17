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
  await go(page, "#/ports/port", "Ports & protocols");
  await page.locator("code", { hasText: "443/udp" }).first().waitFor({ timeout: 15000 });
  await shot(page, "30-ports");
  await go(page, "#/ports/in", "Ports & protocols");
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
    await waRow.getByRole("button", { name: "Users", exact: true }).click();
    await page.locator("dialog[open] table, dialog[open] .empty").first().waitFor({ timeout: 15000 });
    await shot(page, "33-app-users");
    await dlgButton(page, "Close").click();
    await go(page, "#/apps/video", "Apps on network");
    await page.locator(".tabs a.active", { hasText: /^video/ }).waitFor({ timeout: 15000 });
    ok("apps on network: list, who uses an app, category filter");
  } else console.log("     (no app inventory on this server — skipped)");

  // blocking: make a policy in the editor, give it to a user, WhatsApp only, router script, delete
  await go(page, "#/blocking", "Blocking");
  await page.getByRole("button", { name: "+ New policy" }).click();
  const ed = page.locator("dialog[open]");
  await ed.locator("input[name=name]").fill("ui-kids");
  await ed.locator("label.check", { hasText: /^social-video/ }).click();
  await ed.locator("label.check", { hasText: /^Block VPN/ }).click();
  await ed.locator("input[type=search]").fill("pubg");
  await ed.locator("label.chip", { hasText: "PUBG Mobile" }).click();
  await ed.locator("label.field", { hasText: /^When/ }).locator("select").first().selectOption("time");
  const policyText = await ed.locator("pre.code-box").textContent();
  for (const want of ["block social-video time=9h-17h,mon,tue,wed,thu,fri,sat", "block-app PUBG Mobile time=9h-17h", "block-vpn time=9h-17h"])
    if (!policyText.includes(want)) throw new Error(`policy text misses "${want}":\n${policyText}`);
  await shot(page, "40-policy-editor");
  await clickToast(page, dlgButton(page, "Save policy"));
  const kidsCard = page.locator(".policy-card", { has: page.locator("h2 span", { hasText: /^ui-kids$/ }) });
  await kidsCard.waitFor({ timeout: 30000 });
  await page.locator("input[list=bl-users]").fill("ui-user");
  await page.locator("#bl-upol").selectOption("ui-kids");
  await clickToast(page, page.locator(".card", { hasText: "Give a policy to a user" }).getByRole("button", { name: "Apply" }));
  await kidsCard.locator("div.muted", { hasText: /Used by:.*ui-user/ }).waitFor({ timeout: 30000 });
  ok("blocking: policy made in the editor (category + app + VPN + time) and given to a user");
  await page.locator("input[list=bl-users]").fill("ui-user");
  await page.locator("#bl-upol").selectOption("whatsapp-only");
  await clickToast(page, page.locator(".card", { hasText: "Give a policy to a user" }).getByRole("button", { name: "Apply" }));
  await page.locator(".policy-card", { has: page.locator("h2 span", { hasText: /^whatsapp-only$/ }) }).locator("div.muted", { hasText: /Used by:.*ui-user/ }).waitFor({ timeout: 30000 });
  ok("blocking: WhatsApp-only given to a user");
  await page.locator("input[placeholder^='server IP']").fill("192.168.88.10");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "⬇ Download router script" }).click()]);
  const syncRsc = require("fs").readFileSync(await dl.path(), "utf8");
  if (!syncRsc.includes("/api/public/router") || syncRsc.includes("PUT-THE-KEY-HERE") || !syncRsc.includes("address=192.168.88.10"))
    throw new Error("router auto-sync script not filled in");
  ok("router auto-sync script downloaded with server, IP and key");
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
    if ((await ac.locator(".alert-events input[type=checkbox]").count()) !== 8) throw new Error("alerts: 8 event switches expected");
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
  ok("settings: alerts card (Telegram / WhatsApp / email, 8 events), no secrets in page, bad phone refused");

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
    ["#/settings", "Settings", "14-settings"], ["#/health", "Health check", "14b-health"]]) {
    await go(page, hash, title);
    if (hash === "#/health") await page.locator(".health-row").first().waitFor({ timeout: 60000 });
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
