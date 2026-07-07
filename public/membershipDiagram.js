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

  function memberLabel(row) {
    const name = row.Name || row.SamAccountName || row.DisplayName || 'member';
    const cls = row.objectClass || row.ObjectClass || 'object';
    return `${name} (${cls})`;
  }

  function nodeDecl(id, label, objectClass, isRoot) {
    const esc = escapeMermaidLabel(label);
    if (isRoot) return `${id}[["${esc}"]]`;
    switch (objectClass) {
      case 'user':
        return `${id}("${esc}")`;
      case 'group':
        return `${id}[("${esc}")]`;
      case 'computer':
        return `${id}{{"${esc}"}}`;
      default:
        return `${id}["${esc}"]`;
    }
  }

  function inferRootGroup(rows, meta) {
    if (meta?.rootGroup) return meta.rootGroup;
    const withPath = rows.find((row) => row.ViaGroup);
    if (withPath?.ViaGroup) return withPath.ViaGroup.split('>')[0].trim();
    return 'Group';
  }

  function isNestedMembership(rows, meta) {
    if (meta?.membershipType === 'nested') return true;
    return rows.some((row) => row.Depth != null || row.ViaGroup);
  }

  function extractContext(data, meta) {
    if (!data) return null;

    if (data.object && Array.isArray(data.related?.members) && data.related.members.length) {
      const rootGroup = data.object.SamAccountName || data.object.Name || data.object.DistinguishedName || 'Group';
      return {
        rows: data.related.members,
        rootGroup,
        nested: false,
      };
    }

    const rows = Array.isArray(data) ? data : (data.object ? [data.object] : [data]);
    if (!rows.length || !rows[0]?.objectClass) return null;

    if (meta?.membershipType === 'direct' || meta?.membershipType === 'nested') {
      return {
        rows,
        rootGroup: inferRootGroup(rows, meta),
        nested: isNestedMembership(rows, meta),
      };
    }

    if (rows.some((row) => row.Depth != null || row.ViaGroup)) {
      return {
        rows,
        rootGroup: inferRootGroup(rows, meta),
        nested: true,
      };
    }

    return null;
  }

  function toMermaid(ctx) {
    const { rows, rootGroup, nested } = ctx;
    const lines = ['flowchart TD'];
    const declared = new Set();
    const edges = new Set();
    const groupNameToId = new Map();

    const rootId = mermaidId('root', rootGroup);
    lines.push(`  ${nodeDecl(rootId, rootGroup, 'group', true)}`);
    declared.add(rootId);
    groupNameToId.set(rootGroup, rootId);

    function ensureGroupNode(name) {
      if (groupNameToId.has(name)) return groupNameToId.get(name);
      const id = mermaidId('group', name);
      if (!declared.has(id)) {
        lines.push(`  ${nodeDecl(id, name, 'group', false)}`);
        declared.add(id);
      }
      groupNameToId.set(name, id);
      return id;
    }

    function addEdge(fromId, toId) {
      const key = `${fromId}-->${toId}`;
      if (edges.has(key)) return;
      edges.add(key);
      lines.push(`  ${fromId} --> ${toId}`);
    }

    rows.forEach((row) => {
      const key = row.DistinguishedName || row.SamAccountName || row.Name;
      if (!key) return;

      const nodeId = mermaidId('member', key);
      const label = memberLabel(row);
      const objectClass = row.objectClass || row.ObjectClass || 'object';

      if (!declared.has(nodeId)) {
        lines.push(`  ${nodeDecl(nodeId, label, objectClass, false)}`);
        declared.add(nodeId);
      }

      if (objectClass === 'group') {
        groupNameToId.set(row.Name || row.SamAccountName, nodeId);
      }

      if (!nested || row.Depth === 1) {
        addEdge(rootId, nodeId);
        return;
      }

      if (row.ViaGroup) {
        const parts = row.ViaGroup.split('>').map((part) => part.trim()).filter(Boolean);
        const parentName = parts[parts.length - 1] || rootGroup;
        const parentId = ensureGroupNode(parentName);
        addEdge(parentId, nodeId);
        return;
      }

      addEdge(rootId, nodeId);
    });

    lines.push('  classDef rootNode fill:#2d3250,color:#fff,stroke:#1b1f3a,stroke-width:2px');
    lines.push(`  class ${rootId} rootNode`);
    return lines.join('\n');
  }

  window.MembershipDiagram = { extractContext, toMermaid };
})();
