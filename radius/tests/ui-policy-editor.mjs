// Policy editor: every rule keeps its own time.
//   URL=https://127.0.0.1:8443 USER=admin PASS=... node tests/ui-policy-editor.mjs      (on the server, as root)
// 1. every policy opened in the editor gives back the same rules (nothing lost, times kept)
// 2. a new policy with a different time per category / app / site / internet off is saved as expected
// 3. lines the editor cannot show (the same category twice) are kept as they are
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
import { readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
const URL = process.env.URL || "https://127.0.0.1:8443";
const POL = process.env.POLICY_DIR || "/var/lib/mikrotiklover/policies";
let fails = 0;
const ok = (name, cond, info = "") => { console.log((cond ? "ok   " : "FAIL ") + name + (cond ? "" : `: ${info}`)); if (!cond) fails++; };
const norm = (t) => t.split("\n").map((l) => l.split("#")[0].trim().replace(/\s+/g, " ")).filter(Boolean).sort().join("\n");
const admin = (...a) => { try { return execFileSync("radius-admin", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return String(e.stdout || e); } };

const b = await chromium.launch();
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
p.on("console", (m) => { if (m.type() === "error" && !/401/.test(m.text())) errs.push(m.text()); });
await p.goto(URL + "/");
await p.fill("input[name=username]", process.env.USER); await p.fill("input[name=password]", process.env.PASS); await p.keyboard.press("Enter");
await p.waitForSelector(".nav");

async function openEditor(pol) {
  await p.goto(URL + "/#/dashboard"); await p.waitForTimeout(200);
  await p.goto(URL + "/#/blocking/policies"); await p.waitForTimeout(600);
  if (!pol) { await p.getByRole("button", { name: "+ New policy" }).click(); }
  else {
    const card = p.locator(".card").filter({ has: p.locator(`text=${pol.description || pol.name}`) }).filter({ has: p.getByRole("button", { name: "Edit", exact: true }) }).last();
    await card.getByRole("button", { name: "Edit", exact: true }).click();
  }
  await p.locator("dialog[open] pre.code-box").waitFor();
}
const editorText = () => p.locator("dialog[open] pre.code-box").textContent();

// 1. round trip
const meta = await p.evaluate(async () => (await fetch("/api/blocking")).json());
for (const pol of meta.policies) {
  await openEditor(pol);
  const got = await editorText(), want = readFileSync(`${POL}/${pol.name}.txt`, "utf8");
  ok(`round trip: ${pol.name}`, norm(got) === norm(want), `\n  file:   ${norm(want).replace(/\n/g, " | ")}\n  editor: ${norm(got).replace(/\n/g, " | ")}`);
  await p.keyboard.press("Escape");
}

// only these apps: a policy with two app profiles shows both ticked and keeps both
const two = meta.policies.find((x) => x.name === "whatsapp-hikconnect");
if (two) {
  await openEditor(two);
  const dd = p.locator("dialog[open]");
  ok("only-apps policy: mode and both apps ticked", (await dd.locator("select").first().inputValue()) === "only"
    && await dd.locator("label.chip", { hasText: /^whatsapp$/ }).locator("input").isChecked() && await dd.locator("label.chip", { hasText: /^hikconnect$/ }).locator("input").isChecked());
  await dd.locator("label.chip", { hasText: /^hikconnect$/ }).locator("input").uncheck();
  ok("  ... untick one: only the other stays", norm(await editorText()) === norm("allow-only whatsapp"));
  await p.keyboard.press("Escape");
}

// 2. a new policy, one time per rule
admin("policy", "del", "ui-times");
await openEditor(null);
const d = p.locator("dialog[open]");
await d.locator("input[name=name]").fill("ui-times");
await d.locator("input[placeholder^='e.g. Kids']").fill("UI test: own time per rule");
const rowOf = (title) => d.locator(".rule-row").filter({ has: p.locator(`b:text-is("${title}")`) });
await rowOf("social").locator("label.check > input[type=checkbox]").check();
await rowOf("social").locator("select.tp-sel").selectOption({ label: "Office hours (9–17, Mon–Sat)" });
await rowOf("gaming").locator("label.check > input[type=checkbox]").check();                         // always
await d.locator("input[placeholder^='Search apps']").fill("tiktok");
await d.locator("label.chip", { hasText: "TikTok" }).first().locator("input").check();
const app = d.locator(".rule-row.item").filter({ hasText: "TikTok" });
await app.locator("select.tp-sel").selectOption("custom");
const sels = app.locator(".tp-custom select");
await sels.nth(0).selectOption("16"); await sels.nth(1).selectOption("19");
for (const day of ["sat", "sun"]) await app.locator("label.chip", { hasText: day }).locator("input").uncheck();
await d.getByRole("button", { name: "Add a site" }).click();
const site = d.locator(".rule-row.item").filter({ has: p.locator("input[placeholder='example-bet.com']") }).last();
await site.locator("input[placeholder='example-bet.com']").fill("https://www.Example-Bet.com/path");
await site.locator("select.tp-sel").selectOption("custom");
await site.locator(".tp-custom select").nth(0).selectOption("22"); await site.locator(".tp-custom select").nth(1).selectOption("6");
for (const day of ["sat", "sun"]) await site.locator("label.chip", { hasText: day }).locator("input").check();
await rowOf("Internet off completely").locator("label.check > input[type=checkbox]").check();
await rowOf("Internet off completely").locator("select.tp-sel").selectOption("custom");
const offSel = rowOf("Internet off completely").locator(".tp-custom select");
await offSel.nth(0).selectOption("0"); await offSel.nth(1).selectOption("6");
await d.locator("textarea").last().fill("linkedin.com");
const expect = ["block social time=9h-17h,mon,tue,wed,thu,fri,sat", "block gaming", "block-app TikTok time=16h-19h,mon,tue,wed,thu,fri",
  "block-site example-bet.com time=22h-6h,mon,tue,wed,thu,fri,sat,sun", "block-all time=0s-6h,mon,tue,wed,thu,fri", "allow-site linkedin.com"];
const shown = await editorText();
ok("editor: each rule with its own time", norm(shown) === norm(expect.join("\n")), `\n  got:  ${norm(shown).replace(/\n/g, " | ")}\n  want: ${norm(expect.join("\n")).replace(/\n/g, " | ")}`);
await d.getByRole("button", { name: "Save policy" }).click();
await p.locator(".toast").last().waitFor();
let saved = "";
try { saved = readFileSync(`${POL}/ui-times.txt`, "utf8"); } catch { saved = ""; }
ok("saved file = what the editor showed", norm(saved) === norm(expect.join("\n")), saved);
const rsc = readFileSync("/var/lib/mikrotiklover/router/webfilter-policies.rsc", "utf8");
ok("router: social only at office time, gaming always", /chain=wfp-ui-times .*jump-target=wf-social time=9h-17h,mon,tue,wed,thu,fri,sat/.test(rsc)
  && /chain=wfp-ui-times .*jump-target=wf-gaming comment/.test(rsc));
ok("router: site 22:00-06:00 split at midnight", /tls-host="example-bet.com".*time=22h-23h59m59s/.test(rsc) && /tls-host="example-bet.com".*time=0s-6h/.test(rsc));

// 3. lines the editor cannot show are kept
writeFileSync(`${POL}/ui-times.txt`, "# UI test: own time per rule\nblock social time=9h-12h,mon\nblock social time=14h-17h,mon\nblock gaming\n");
await openEditor({ name: "ui-times", description: "UI test: own time per rule" });
const t3 = await editorText();
ok("second line for the same category kept", norm(t3) === norm("block social time=9h-12h,mon\nblock social time=14h-17h,mon\nblock gaming"), t3);
ok("  ... and shown as 'other rules'", (await d.locator(".note", { hasText: "Other rules" }).textContent()).includes("block social time=14h-17h,mon"));
await rowOf("gaming").locator("select.tp-sel").selectOption({ label: "Office hours (9–17, Mon–Sat)" });
ok("changing one rule leaves the others", norm(await editorText()) === norm("block social time=9h-12h,mon\nblock social time=14h-17h,mon\nblock gaming time=9h-17h,mon,tue,wed,thu,fri,sat"));
await p.keyboard.press("Escape");

// phone width: no sideways scrolling in the editor
await p.setViewportSize({ width: 390, height: 800 });
await openEditor({ name: "ui-times", description: "UI test: own time per rule" });
ok("phone: editor fits the screen", !(await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/116-policy-times-phone.png`, fullPage: false });
await p.keyboard.press("Escape");
admin("policy", "del", "ui-times");
ok("no console / CSP errors", errs.length === 0, errs.join(" | "));
await b.close();
console.log(fails ? `${fails} FAILED` : "all policy editor tests passed");
process.exit(fails ? 1 : 0);
