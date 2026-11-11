'use strict';

// Prüft im echten Browser, dass MiroTalk nichts von fremden Hosts lädt
// (adm/hetzner#39). Ergänzt apply.js: das sieht nur den Quelltext, dies
// auch, was Bibliotheken zur Laufzeit nachladen (Schriften, emoji-mart-Daten).
//
//   node browser-check.js [base-url] [screenshot-dir]
//
// Braucht playwright samt Chromium, im CI das Image mcr.microsoft.com/playwright.
// Der Server soll so konfiguriert sein wie in Produktion, was fremde Dienste
// angeht (UI_TRANSLATION_MODE=native, STATS_ENABLED=false), aber ohne
// HOST_PROTECTED, sonst führt /join nicht in den Raum.
//
// Rückgabe: 0 in Ordnung, 1 Befund, 3 Server nicht erreichbar.

const { chromium } = require('playwright');

const BASE = process.argv[2] || 'http://127.0.0.1:3010';
const SHOT_DIR = process.argv[3] || '';
const LOCAL_HOST = new URL(BASE).host;

const PAGES = [
    { path: '/', fonts: ['IBM Plex Sans'] },
    { path: '/login', fonts: ['IBM Plex Sans'] },
    { path: '/newroom', fonts: ['IBM Plex Sans'] },
    { path: '/whoAreYou/browsercheck', fonts: ['IBM Plex Sans'] },
    {
        path: '/join?room=browsercheck&roomPassword=0&name=check&audio=0&video=1&screen=0&notify=0&hide=0',
        fonts: ['Montserrat', 'Font Awesome 6 Free'],
    },
];

// Antworten >= 400, die zum Testaufbau gehören und keinen Fehler zeigen.
// /isRoomActive antwortet ohne HOST_PROTECTED immer 400 (Server.js).
const EXPECTED_HTTP_ERRORS = [/\/isRoomActive$/];

async function checkPage(context, spec, index) {
    const page = await context.newPage();
    const findings = [];
    const consoleErrors = [];
    page.on('request', (request) => {
        const url = request.url();
        if (url.startsWith('data:') || url.startsWith('blob:')) return;
        if (new URL(url).host !== LOCAL_HOST) findings.push(`fremder Abruf: ${url}`);
    });
    page.on('response', (response) => {
        const url = response.url().split('?')[0];
        if (response.status() >= 400 && !EXPECTED_HTTP_ERRORS.some((re) => re.test(url))) {
            findings.push(`HTTP ${response.status()}: ${response.url()}`);
        }
    });
    page.on('requestfailed', (request) => {
        const error = request.failure()?.errorText || '';
        // Abgebrochen wird beim Seitenwechsel, das ist kein Fehler.
        if (error !== 'net::ERR_ABORTED') findings.push(`Abruf gescheitert (${error}): ${request.url()}`);
    });
    page.on('pageerror', (error) => findings.push(`JS-Fehler: ${String(error).slice(0, 200)}`));
    page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
    });

    try {
        await page.goto(BASE + spec.path, { waitUntil: 'networkidle', timeout: 45000 });
    } catch (error) {
        findings.push(`Seite lädt nicht: ${error.message.split('\n')[0]}`);
    }
    // Nachzügler: emoji-mart holt seine Daten erst nach dem Aufbau des Raums.
    await page.waitForTimeout(4000);

    const loaded = await page.evaluate(() =>
        [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family.replace(/["']/g, '')),
    );
    for (const family of spec.fonts) {
        if (!loaded.includes(family)) findings.push(`Schrift nicht geladen: ${family}`);
    }

    if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/page${index}.png` });
    await page.close();
    return { findings, consoleErrors, fonts: [...new Set(loaded)] };
}

(async () => {
    try {
        const response = await fetch(`${BASE}/brand`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
        process.stderr.write(`[FEHLER] ${BASE} nicht erreichbar: ${error.message}\n`);
        process.exit(3);
    }

    const browser = await chromium.launch({
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    let total = 0;
    for (const [index, spec] of PAGES.entries()) {
        const { findings, consoleErrors, fonts } = await checkPage(context, spec, index);
        total += findings.length;
        process.stdout.write(`${findings.length ? '[FEHLER]' : '[OK]    '} ${spec.path}\n`);
        process.stdout.write(`         Schriften: ${fonts.join(', ') || '-'}\n`);
        for (const finding of findings) process.stdout.write(`         ${finding}\n`);
        for (const text of consoleErrors) process.stdout.write(`         [INFO] Konsole: ${text}\n`);
    }
    await browser.close();
    if (total > 0) {
        process.stdout.write(`[FEHLER] ${total} Befund(e)\n`);
        process.exit(1);
    }
    process.stdout.write('[OK] Keine fremden Abrufe, alle Schriften geladen\n');
})();
