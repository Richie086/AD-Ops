function toArray(data) {
  if (data == null) return [];
  return Array.isArray(data) ? data : [data];
}

function collectColumns(rows) {
  const cols = [];
  const seen = new Set();
  for (const row of rows) {
    if (row && typeof row === 'object') {
      for (const k of Object.keys(row)) {
        if (!seen.has(k)) {
          seen.add(k);
          cols.push(k);
        }
      }
    }
  }
  return cols.length ? cols : ['value'];
}

function cellText(row, col) {
  if (row == null) return '';
  if (typeof row !== 'object') return col === 'value' ? String(row) : '';
  const v = row[col];
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeXml(s) {
  return escapeHtml(s).replace(/'/g, '&apos;');
}

function toMarkdown(title, rows, meta = {}) {
  const cols = collectColumns(rows);
  let out = `# ${title}\n\n`;
  if (meta.command) out += `**Command:** \`${meta.command}\`\n\n`;
  if (meta.generatedAt) out += `**Generated:** ${meta.generatedAt}\n\n`;
  out += `| ${cols.join(' | ')} |\n`;
  out += `| ${cols.map(() => '---').join(' | ')} |\n`;
  for (const row of rows) {
    out += `| ${cols.map((c) => cellText(row, c).replace(/\|/g, '\\|')).join(' | ')} |\n`;
  }
  return out;
}

function toText(title, rows, meta = {}) {
  const cols = collectColumns(rows);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cellText(r, c).length), 4));
  let out = `${title}\n${'='.repeat(title.length)}\n\n`;
  if (meta.command) out += `Command: ${meta.command}\n`;
  if (meta.generatedAt) out += `Generated: ${meta.generatedAt}\n`;
  out += '\n';
  out += cols.map((c, i) => c.padEnd(widths[i])).join('  ') + '\n';
  out += cols.map((c, i) => '-'.repeat(widths[i])).join('  ') + '\n';
  for (const row of rows) {
    out += cols.map((c, i) => cellText(row, c).padEnd(widths[i])).join('  ') + '\n';
  }
  return out;
}

function toXml(title, rows, meta = {}) {
  const rootTag = 'Report';
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  out += `<${rootTag} title="${escapeXml(title)}" generatedAt="${escapeXml(meta.generatedAt || '')}">\n`;
  if (meta.command) out += `  <Command>${escapeXml(meta.command)}</Command>\n`;
  out += `  <Results>\n`;
  for (const row of rows) {
    out += `    <Item>\n`;
    const cols = collectColumns([row]);
    for (const c of cols) {
      const tag = c.replace(/[^a-zA-Z0-9_]/g, '_') || 'field';
      out += `      <${tag}>${escapeXml(cellText(row, c))}</${tag}>\n`;
    }
    out += `    </Item>\n`;
  }
  out += `  </Results>\n`;
  out += `</${rootTag}>\n`;
  return out;
}

function toHtml(title, rows, meta = {}) {
  const cols = collectColumns(rows);
  let out = `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>\n`;
  out += `<style>
    body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:2rem;color:#1a1a2e;background:#f7f8fb;}
    h1{font-size:1.4rem;margin-bottom:.25rem;}
    .meta{color:#666;font-size:.85rem;margin-bottom:1.25rem;}
    table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08);}
    th,td{border:1px solid #e2e5eb;padding:.5rem .75rem;text-align:left;font-size:.85rem;}
    th{background:#2d3250;color:#fff;position:sticky;top:0;}
    tr:nth-child(even){background:#fafbfc;}
  </style></head><body>\n`;
  out += `<h1>${escapeHtml(title)}</h1>\n`;
  if (meta.command) out += `<div class="meta">Command: <code>${escapeHtml(meta.command)}</code></div>\n`;
  if (meta.generatedAt) out += `<div class="meta">Generated: ${escapeHtml(meta.generatedAt)}</div>\n`;
  out += `<table><thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>\n`;
  for (const row of rows) {
    out += `<tr>${cols.map((c) => `<td>${escapeHtml(cellText(row, c))}</td>`).join('')}</tr>\n`;
  }
  out += `</tbody></table>\n</body></html>\n`;
  return out;
}

function generateReport(format, title, data, meta = {}) {
  const rows = toArray(data);
  const fullMeta = { generatedAt: new Date().toISOString(), ...meta };
  switch (format) {
    case 'md':
      return { content: toMarkdown(title, rows, fullMeta), mime: 'text/markdown', ext: 'md' };
    case 'txt':
      return { content: toText(title, rows, fullMeta), mime: 'text/plain', ext: 'txt' };
    case 'xml':
      return { content: toXml(title, rows, fullMeta), mime: 'application/xml', ext: 'xml' };
    case 'html':
      return { content: toHtml(title, rows, fullMeta), mime: 'text/html', ext: 'html' };
    default:
      throw new Error('Unsupported format: ' + format);
  }
}

module.exports = { generateReport };
