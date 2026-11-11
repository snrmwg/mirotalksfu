#!/usr/bin/env node
'use strict';

// Ersetzt CDN-URLs in public/ durch lokale Kopien unter public/vendor/
// (adm/hetzner#39). Läuft im Docker-Build, nach `npm ci` in vendor/.
//
//   node apply.js <vendor-dir> <public-dir>
//
// Was ersetzt wird, steht in assets.tsv; bekannte, bewusst stehen gelassene
// Fundstellen in allow.tsv. Danach durchsucht das Script ganz public/
// (auch die kopierten Bibliotheken) nach fremden Hosts. Bleibt eine Fundstelle
// übrig, die allow.tsv nicht nennt, endet es mit Rückgabe 1 und der Build
// bricht ab.
//
// Rückgabe: 0 in Ordnung, 1 fremde URL übrig, 2 Aufruf falsch,
// 3 Eingabe fehlt oder ist nicht lesbar.

const fs = require('fs');
const path = require('path');

const BLOCKED_HOSTS = [
    'cdn.jsdelivr.net',
    'cdnjs.cloudflare.com',
    'unpkg.com',
    'esm.sh',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'storage.googleapis.com',
    'buttons.github.io',
    'w3schools.com',
    'api.dicebear.com',
    'gravatar.com',
];
const SCANNED_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.json']);
// Danach endet eine URL in HTML, CSS und JS-Strings.
const URL_END = `(?=["'\`)\\s<])`;

function fail(code, message) {
    process.stderr.write(`[FEHLER] ${message}\n`);
    process.exit(code);
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readTable(file, columns) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        fail(3, `${file} nicht lesbar: ${error.message}`);
    }
    const rows = [];
    text.split('\n').forEach((line, index) => {
        if (line.trim() === '' || line.startsWith('#')) return;
        const cells = line.split('\t');
        if (cells.length !== columns) {
            fail(3, `${file}:${index + 1}: ${columns} Spalten erwartet, ${cells.length} gefunden`);
        }
        rows.push({ cells, where: `${file}:${index + 1}` });
    });
    return rows;
}

function walk(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...walk(full));
        else if (entry.isFile()) files.push(full);
    }
    return files;
}

// Ein `*` steht für genau ein Verzeichnis, mehr braucht assets.tsv nicht.
function expandSource(vendorDir, source) {
    const parts = source.split('/');
    const star = parts.indexOf('*');
    if (star === -1) return [source];
    const base = parts.slice(0, star).join('/');
    const rest = parts.slice(star + 1).join('/');
    return fs
        .readdirSync(path.join(vendorDir, base), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${base}/${entry.name}/${rest}`)
        .filter((candidate) => fs.existsSync(path.join(vendorDir, candidate)));
}

function servedPath(source) {
    return source.replace(/^node_modules\//, '');
}

function main() {
    const [vendorDir, publicDir] = process.argv.slice(2);
    if (!vendorDir || !publicDir) {
        fail(2, 'Aufruf: node apply.js <vendor-dir> <public-dir>');
    }
    if (!fs.existsSync(path.join(vendorDir, 'node_modules'))) {
        fail(3, `${vendorDir}/node_modules fehlt. Vorher in ${vendorDir}: npm ci --ignore-scripts`);
    }
    if (!fs.existsSync(path.join(publicDir, 'views'))) {
        fail(3, `${publicDir}/views fehlt. Ist ${publicDir} das public/ von MiroTalk?`);
    }

    const assets = readTable(path.join(vendorDir, 'assets.tsv'), 3);
    const allowed = readTable(path.join(vendorDir, 'allow.tsv'), 3);
    const targetDir = path.join(publicDir, 'vendor');

    // 1. Kopieren
    let copied = 0;
    for (const { cells, where } of assets) {
        const [kind, , source] = cells;
        if (kind !== 'file' && kind !== 'copy') continue;
        const sources = expandSource(vendorDir, source);
        if (sources.length === 0) fail(3, `${where}: ${source} gibt es nicht`);
        for (const one of sources) {
            const from = path.join(vendorDir, one);
            if (!fs.existsSync(from)) fail(3, `${where}: ${one} gibt es nicht`);
            const to = path.join(targetDir, servedPath(one));
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.cpSync(from, to, { recursive: true });
            copied++;
        }
    }

    // 2. Ersetzen, längste URL zuerst: .../npm/flatpickr ist Anfang von
    //    .../npm/flatpickr/dist/flatpickr.min.css.
    const rules = assets
        .filter(({ cells }) => ['file', 'prefix', 'drop'].includes(cells[0]))
        .map(({ cells, where }) => {
            const [kind, url, source] = cells;
            const local = `/vendor/${servedPath(source)}`;
            if (kind === 'prefix') {
                if (!url.endsWith('/')) fail(3, `${where}: prefix muss auf / enden`);
                return { url, where, pattern: new RegExp(escapeRegExp(url), 'g'), replacement: local, hits: 0 };
            }
            if (kind === 'drop') {
                const quoted = `"${escapeRegExp(url)}"`;
                const pattern = new RegExp(
                    `[ \\t]*(?:<script\\b[^>]*\\bsrc=${quoted}[^>]*>\\s*</script>|<link\\b[^>]*\\bhref=${quoted}[^>]*>)[ \\t]*\\n?`,
                    'g',
                );
                return { url, where, pattern, replacement: '', hits: 0 };
            }
            return {
                url,
                where,
                pattern: new RegExp(escapeRegExp(url) + URL_END, 'g'),
                replacement: local,
                hits: 0,
            };
        })
        .sort((a, b) => b.url.length - a.url.length);

    const files = walk(publicDir).filter((file) => SCANNED_EXTENSIONS.has(path.extname(file)));
    let changedFiles = 0;
    for (const file of files) {
        const before = fs.readFileSync(file, 'utf8');
        let text = before;
        for (const rule of rules) {
            text = text.replace(rule.pattern, () => {
                rule.hits++;
                return rule.replacement;
            });
        }
        if (text !== before) {
            fs.writeFileSync(file, text);
            changedFiles++;
        }
    }
    for (const rule of rules) {
        if (rule.hits === 0) process.stderr.write(`[!] ${rule.where}: nirgends gefunden: ${rule.url}\n`);
    }
    process.stderr.write(`[INFO] ${copied} Quellen kopiert, ${changedFiles} Dateien geändert\n`);

    // 3. Prüfen
    const hostPattern = new RegExp(`https?://(?:[a-z0-9-]+\\.)*(?:${BLOCKED_HOSTS.map(escapeRegExp).join('|')})`, 'gi');
    const allowHits = allowed.map(({ cells, where }) => ({ file: cells[0], start: cells[1], where, hits: 0 }));
    const findings = [];
    for (const file of files) {
        const relative = path.relative(publicDir, file).split(path.sep).join('/');
        const text = fs.readFileSync(file, 'utf8');
        for (const match of text.matchAll(hostPattern)) {
            const entry = allowHits.find((allow) => allow.file === relative && text.startsWith(allow.start, match.index));
            if (entry) {
                entry.hits++;
                continue;
            }
            const line = text.slice(0, match.index).split('\n').length;
            findings.push(`${relative}:${line}: ${text.slice(match.index, match.index + 100).split(/["'`\s]/)[0]}`);
        }
    }
    for (const allow of allowHits) {
        if (allow.hits === 0) process.stderr.write(`[!] ${allow.where}: Ausnahme ohne Fundstelle, streichen\n`);
    }
    if (findings.length > 0) {
        process.stderr.write(`[FEHLER] ${findings.length} fremde URL(s) übrig:\n`);
        for (const finding of findings) process.stderr.write(`  ${finding}\n`);
        process.stderr.write('  Eintragen in vendor/assets.tsv (ersetzen) oder vendor/allow.tsv (mit Grund).\n');
        process.exit(1);
    }
    process.stderr.write('[OK] Keine fremden URLs mehr in public/\n');
}

main();
