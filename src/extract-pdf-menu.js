import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

function clean(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizedName(value) {
  return clean(value.replace(/\s+([,.)])/g, '$1'));
}

export async function extractPdfMenu(bytes) {
  const loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const document = await loadingTask.promise;
  const products = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const rows = new Map();
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5] / 3) * 3;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: item.transform[4], text: item.str });
    }
    const names = [...rows].map(([y, fragments]) => {
      const left = fragments.filter(part => part.x < 320).sort((a, b) => a.x - b.x);
      if (!left.some(part => /\p{L}/u.test(part.text))) return null;
      const name = normalizedName(left.map(part => {
        const value = part.text.trim();
        return /^(?:\p{Lu}\s+)+\p{Lu}[,.]?$/u.test(value) ? value.replace(/(?<=\p{Lu})\s+(?=\p{Lu})/gu, '') : value;
      }).join(' '));
      return { y, name, spaced: left.some(part => /(?:\p{Lu}\s+){2,}\p{Lu}/u.test(part.text)) };
    }).filter(Boolean);
    for (const [y, fragments] of rows) {
      const line = clean(fragments.filter(part => part.x >= 320).sort((a, b) => a.x - b.x).map(part => part.text).join(' '));
      const price = line.match(/(?:€\s*(\d{1,3}\s*,\s*\d{1,2})|(\d{1,3}(?:\s*\d)?\s*,\s*\d{1,2})\s*€)/);
      if (!price) continue;
      const closest = names.map(item => ({ ...item, distance: Math.abs(item.y - y) }))
        .filter(item => item.distance <= 18)
        .sort((a, b) => Number(b.spaced) - Number(a.spaced) || a.distance - b.distance)[0];
      if (!closest || closest.distance > 18 || closest.name.length > 100) continue;
      products.push({ nombre: closest.name, precio: Number((price[1] ?? price[2]).replace(/\s/g, '').replace(',', '.')), moneda: 'EUR', pagina: pageNumber });
    }
  }
  const paginas = document.numPages;
  await loadingTask.destroy();
  return { paginas, productos: products };
}
