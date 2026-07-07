(() => {
  function escapeMermaidLabel(value) {
    return String(value)
      .replace(/"/g, "'")
      .replace(/\[/g, '(')
      .replace(/\]/g, ')')
      .replace(/#/g, '')
      .replace(/;/g, ',');
  }

  function extractContext(data, meta) {
    if (meta?.diagramType !== 'ou') return null;
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length || !rows[0]?.DistinguishedName) return null;
    if (!rows.some((row) => row.ParentDistinguishedName !== undefined || row.objectClass === 'domain' || row.objectClass === 'organizationalUnit')) {
      return null;
    }
    return { rows, rootDn: rows.find((row) => !row.ParentDistinguishedName)?.DistinguishedName || rows[0].DistinguishedName };
  }

  function normalizeRows(rows) {
    const dnSet = new Set(rows.map((row) => row.DistinguishedName));
    const root = rows.find((row) => !row.ParentDistinguishedName);
    return rows.map((row) => {
      if (!row.ParentDistinguishedName || dnSet.has(row.ParentDistinguishedName)) return row;
      return { ...row, ParentDistinguishedName: root?.DistinguishedName || row.ParentDistinguishedName };
    });
  }

  function toMermaid(ctx) {
    const rows = normalizeRows(ctx.rows);
    const childMap = new Map();

    rows.forEach((row) => {
      if (!row.ParentDistinguishedName) return;
      if (!childMap.has(row.ParentDistinguishedName)) childMap.set(row.ParentDistinguishedName, []);
      childMap.get(row.ParentDistinguishedName).push(row);
    });

    const root = rows.find((row) => !row.ParentDistinguishedName) || rows[0];
    const rootLabel = root.Name || root.DistinguishedName;
    const lines = ['mindmap', `  root((${escapeMermaidLabel(rootLabel)}))`];

    function emitChildren(parentDn, depth) {
      const kids = childMap.get(parentDn) || [];
      kids.forEach((child) => {
        lines.push(`${' '.repeat(2 + depth * 2)}${escapeMermaidLabel(child.Name || child.DistinguishedName)}`);
        emitChildren(child.DistinguishedName, depth + 1);
      });
    }

    emitChildren(root.DistinguishedName, 0);
    return lines.join('\n');
  }

  window.OuDiagram = { extractContext, toMermaid };
})();
