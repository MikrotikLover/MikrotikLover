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
const ok = (msg) => console.log(`ok   ${msg}`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 }, ...opts });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" && !/401/.test(m.text())) errors.push(`[${step}] console: ${m.text()}`); });
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

  for (const [hash, title, name] of [["#/online", "Online", "08-online"], ["#/live", "Live log", "09-live"],
    ["#/reports/sites", "Reports", "10-reports-sites"], ["#/reports/blocked", "Reports", "11-reports-blocked"],
    ["#/data/site", "Data usage", "12-data-site"], ["#/data/ip", "Data usage", "13-data-ip"],
    ["#/settings", "Settings", "14-settings"]]) {
    await go(page, hash, title);
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
