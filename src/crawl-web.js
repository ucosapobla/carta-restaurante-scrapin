import { chromium } from 'playwright';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { mapsBrowserExecutable, profileDirectory } from './browser-profile.js';
import { acquireLock, hash, readJson, saveJson } from './storage.js';
import { navigateMaps, ready } from './maps-page.js';
import { extractPdfMenu } from './extract-pdf-menu.js';

const inputRoot = path.join('jose', 'faltan las cartas');
const outputRoot = path.join('data', 'recorrido-web');
const menuWords = /(?:carta|men[uú]|menu|food|drink|speisekarte|menue)/i;
const directoryHosts = /(?:google\.|tripadvisor\.|restaurantguru\.|thefork\.|facebook\.|instagram\.|carta\.menu|menumallorca\.|paginasamarillas\.|yelp\.|wikipedia\.|bing\.)/i;

async function loadRestaurants() {
  const folders = (await readdir(inputRoot, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name));
  return Promise.all(folders.map(async entry => {
    const record = await readJson(path.join(inputRoot, entry.name, 'restaurante.json'));
    if (record._id !== entry.name || !record.url_ficha) throw new Error(`Ficha inválida en ${entry.name}`);
    return record;
  }));
}

function sameHost(left, right) {
  const hostname = value => new URL(value).hostname.replace(/^www\./, '');
  return hostname(left) === hostname(right);
}

function streetNumber(address) {
  return address.match(/,\s*(\d+)/)?.[1];
}

function corroborates(record, text) {
  const digits = value => String(value ?? '').replace(/\D/g, '');
  const phone = digits(record.telefono);
  const number = streetNumber(record.direccion);
  const flat = text.toLowerCase();
  const locality = (record.localidad || record.municipio).toLowerCase();
  return (phone.length >= 7 && digits(text).includes(phone)) || Boolean(number && flat.includes(locality) && new RegExp(`\\b${number}\\b`).test(flat));
}

async function mapsWebsite(page, record) {
  await navigateMaps(page, record.url_ficha);
  await ready(page);
  const link = page.locator('a[data-item-id="authority"], a[href^="http"][aria-label*="Sitio web"], a[href^="http"][aria-label*="Website"]').first();
  return await link.getAttribute('href').catch(() => null);
}

async function searchWeb(page, record) {
  const query = `${record.nombre} ${record.localidad || record.municipio} ${streetNumber(record.direccion) ?? ''} restaurante web oficial`;
  await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return page.locator('li.b_algo h2 a').evaluateAll(links => links.map(link => link.href).slice(0, 6));
}

async function inspectWebsite(page, record, url) {
  const candidate = new URL(url);
  if (!['https:', 'http:'].includes(candidate.protocol) || directoryHosts.test(candidate.hostname)) return null;
  const response = await page.goto(candidate.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!response?.ok()) return null;
  const text = await page.locator('body').innerText({ timeout: 10000 });
  const links = await page.locator('a[href]').evaluateAll(anchors => anchors.map(anchor => ({ url: anchor.href, label: anchor.innerText || anchor.getAttribute('aria-label') || '' })));
  return { url: page.url(), verified: corroborates(record, text), links, text: text.slice(0, 50000) };
}

async function findOfficialWebsite(page, record) {
  const mapsUrl = await mapsWebsite(page, record).catch(() => null);
  const candidates = mapsUrl ? [mapsUrl] : [];
  for (const candidate of candidates) {
    try {
      const site = await inspectWebsite(page, record, candidate);
      if (site?.verified) return { ...site, source: 'google_maps' };
    } catch (error) {
      console.log(`ID ${record._id}: no se pudo comprobar ${candidate}: ${error.message}`);
    }
  }
  for (const candidate of await searchWeb(page, record)) {
    try {
      const site = await inspectWebsite(page, record, candidate);
      if (site?.verified) return { ...site, source: 'busqueda' };
    } catch (error) {
      console.log(`ID ${record._id}: no se pudo comprobar ${candidate}: ${error.message}`);
    }
  }
  return null;
}

async function findMenus(page, site) {
  const candidates = site.links.filter(link => menuWords.test(`${link.label} ${link.url}`) && /^https?:/.test(link.url));
  const seen = new Set();
  const menus = [];
  for (const link of candidates.slice(0, 12)) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    if (/\.pdf(?:[?#]|$)/i.test(link.url)) {
      menus.push({ url: link.url, tipo: 'pdf', enlace: link.label });
      continue;
    }
    if (!sameHost(site.url, link.url)) continue;
    try {
      const response = await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!response?.ok()) continue;
      const text = await page.locator('body').innerText();
      const pdfs = await page.locator('a[href$=".pdf"], a[href*=".pdf?"]').evaluateAll(anchors => anchors.map(anchor => ({ url: anchor.href, enlace: anchor.innerText })));
      const images = await page.locator('img').evaluateAll(elements => elements
        .filter(image => image.naturalWidth >= 500 && image.naturalHeight >= 300 && /(?:carta|men[uú]|menu|food|drink|speisekarte|menue)/i.test(`${image.alt} ${image.currentSrc}`))
        .map(image => ({ url: image.currentSrc, enlace: image.alt })));
      menus.push({ url: page.url(), tipo: 'html', enlace: link.label, ...(pdfs.length ? { pdfs } : {}), ...(text.length > 80 ? { texto: text.slice(0, 50000) } : {}) });
      for (const pdf of pdfs) if (!seen.has(pdf.url)) { seen.add(pdf.url); menus.push({ ...pdf, tipo: 'pdf' }); }
      for (const image of images) if (!seen.has(image.url)) { seen.add(image.url); menus.push({ ...image, tipo: 'imagen' }); }
    } catch (error) {
      console.log(`No se pudo abrir ${link.url}: ${error.message}`);
    }
  }
  return menus;
}

function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error('La respuesta no es una imagen PNG, JPEG o WebP');
}

async function saveMenuFile(record, menu, bytes, extension) {
  const folder = path.join(inputRoot, record._id, 'cartas-web');
  await mkdir(folder, { recursive: true });
  const sha256 = hash(bytes);
  const filename = `carta-${sha256}.${extension}`;
  const file = path.join(folder, filename);
  try { await writeFile(file, bytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (hash(await readFile(file)) !== sha256) throw new Error(`El archivo existente ${file} tiene contenido distinto`);
  }
  menu.archivo = path.join('cartas-web', filename);
  menu.sha256 = sha256;
  menu.bytes = bytes.length;
  menu.fecha_descarga = new Date().toISOString();
}

async function downloadMenus(context, record, menus) {
  for (const menu of menus.filter(item => ['pdf', 'imagen'].includes(item.tipo))) {
    try {
      const response = await context.request.get(menu.url, { timeout: 30000, maxRedirects: 5 });
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      const bytes = await response.body();
      if (bytes.length > 20 * 1024 * 1024) throw new Error('Archivo mayor de 20 MB');
      const extension = menu.tipo === 'pdf' ? 'pdf' : imageExtension(bytes);
      if (extension === 'pdf' && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('La respuesta no es un PDF');
      await saveMenuFile(record, menu, bytes, extension);
      if (extension === 'pdf') {
        try {
          const extraction = await extractPdfMenu(bytes);
          menu.paginas = extraction.paginas;
          menu.productos = extraction.productos;
        } catch (error) { menu.error_extraccion = error.message; }
      }
    } catch (error) { menu.error_descarga = error.message; }
  }
  const downloaded = menus.filter(menu => menu.archivo);
  if (downloaded.length) {
    await saveJson(path.join(inputRoot, record._id, 'cartas-web', 'procedencia.json'), {
      _id: record._id,
      signatura: record.signatura,
      archivos: downloaded.map(menu => ({ archivo: menu.archivo, url: menu.url, tipo: menu.tipo, sha256: menu.sha256, bytes: menu.bytes, fecha_descarga: menu.fecha_descarga })),
    });
  }
}

async function main() {
  const { values } = parseArgs({ options: { ids: { type: 'string' }, execute: { type: 'boolean', default: false }, repeat: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  if (values.help) { console.log('Uso: npm run recorrer:web -- [--ids 1215,1220] [--execute] [--repeat]. Sin --execute muestra los pendientes.'); return; }
  const records = await loadRestaurants();
  const ids = values.ids?.split(',');
  if (ids && (ids.some(id => !records.some(record => record._id === id)) || new Set(ids).size !== ids.length)) throw new Error('--ids contiene IDs desconocidos o duplicados');
  const chosen = ids ? ids.map(id => records.find(record => record._id === id)) : records;
  const pending = [];
  for (const record of chosen) {
    const file = path.join(outputRoot, record._id, 'resultado.json');
    const old = await readJson(file, null);
    const fingerprint = hash(JSON.stringify(record));
    if (values.repeat || !old || old.huella_ficha !== fingerprint || old.estado === 'error') pending.push({ record, file, fingerprint });
  }
  if (!values.execute) { console.log(JSON.stringify({ modo: 'simulacion', total: records.length, pendientes: pending.map(({ record }) => ({ id: record._id, nombre: record.nombre })) }, null, 2)); return; }
  if (!pending.length) { console.log('No hay restaurantes pendientes.'); return; }
  const release = await acquireLock(path.join(outputRoot, 'ejecucion.lock'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDirectory(), { executablePath: await mapsBrowserExecutable(), headless: false, locale: 'es-ES', viewport: { width: 1440, height: 1000 }, acceptDownloads: false });
    for (const { record, file, fingerprint } of pending) {
      const page = await context.newPage();
      let result = { _id: record._id, signatura: record.signatura, huella_ficha: fingerprint, fecha_consulta: new Date().toISOString(), estado: 'error' };
      try {
        const site = await findOfficialWebsite(page, record);
        if (!site) result.estado = 'web_no_localizada';
        else {
          const menus = await findMenus(page, site);
          await downloadMenus(context, record, menus);
          result = { ...result, estado: menus.length ? 'carta_localizada' : 'carta_no_localizada_en_web', web_oficial: site.url, origen_web: site.source, cartas: menus };
        }
      } catch (error) { result.error = error.message; process.exitCode = 1; }
      finally { await page.close(); }
      await saveJson(file, result);
      console.log(JSON.stringify({ id: record._id, estado: result.estado, web: result.web_oficial, cartas: result.cartas?.length ?? 0, productos: result.cartas?.reduce((n, menu) => n + (menu.productos?.length ?? 0), 0) ?? 0, error: result.error }));
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } finally { await context?.close(); await release(); }
}

main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
