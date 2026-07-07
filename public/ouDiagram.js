(() => {
  function escapeMermaidLabel(value) {
    return String(value)
      .replace(/"/g, "'")
      .replace(/\[/g, '(')
      .replace(/\]/g, ')')
      .replace(/#/g, '')
      .replace(/;/g, ',');
  }

  function mermaidId(prefix, value) {
    let hash = 0;
    const text = String(value);
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    const safe = text.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 28);
    return `n_${prefix}_${safe}_${Math.abs(hash)}`;
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
    const byDn = new Map(rows.map((row) => [row.DistinguishedName, row]));
    const lines = ['flowchart TD'];
    const declared = new Map();
    const edges = new Set();

    function nodeDecl(row) {
      const isDomain = row.objectClass === 'domain';
      const isRoot = !row.ParentDistinguishedName;
      const label = row.Name || row.DistinguishedName;
      const esc = escapeMermaidLabel(label);
      const id = mermaidId('ou', row.DistinguishedName);
      if (isDomain || isRoot) return { id, line: `${id}[["${esc}"]]` };
      return { id, line: `${id}[("${esc}")]` };
    }

    function ensureNode(row) {
      if (declared.has(row.DistinguishedName)) return declared.get(row.DistinguishedName);
      const { id, line } = nodeDecl(row);
      lines.push(`  ${line}`);
      declared.set(row.DistinguishedName, id);
      return id;
    }

    function addEdge(fromId, toId) {
      const key = `${fromId}-->${toId}`;
      if (edges.has(key)) return;
      edges.add(key);
      lines.push(`  ${fromId} --> ${toId}`);
    }

    rows
      .slice()
      .sort((a, b) => a.DistinguishedName.length - b.DistinguishedName.length)
      .forEach((row) => {
        const nodeId = ensureNode(row);
        if (!row.ParentDistinguishedName) return;
        const parentRow = byDn.get(row.ParentDistinguishedName);
        if (!parentRow) return;
        const parentId = ensureNode(parentRow);
        addEdge(parentId, nodeId);
      });

    const rootRow = rows.find((row) => !row.ParentDistinguishedName) || rows[0];
    if (rootRow) {
      const rootId = declared.get(rootRow.DistinguishedName);
      lines.push('  classDef rootNode fill:#2d3250,color:#fff,stroke:#1b1f3a,stroke-width:2px');
      lines.push('  classDef ouNode fill:#eef2ff,stroke:#4e5d9e');
      if (rootId) lines.push(`  class ${rootId} rootNode`);
      rows.forEach((row) => {
        if (row.objectClass === 'organizationalUnit' && declared.has(row.DistinguishedName)) {
          lines.push(`  class ${declared.get(row.DistinguishedName)} ouNode`);
        }
      });
    }

    return lines.join('\n');
  }

  window.OuDiagram = { extractContext, toMermaid };
})();
