(() => {
  function escapeMermaidLabel(value) {
    return String(value)
      .replace(/"/g, "'")
      .replace(/\[/g, '(')
      .replace(/\]/g, ')')
      .replace(/#/g, '')
      .replace(/;/g, ',');
  }

  function memberLabel(row) {
    const name = row.Name || row.SamAccountName || row.DisplayName || 'member';
    const cls = row.objectClass || row.ObjectClass || 'object';
    return `${name} (${cls})`;
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
    const childMap = new Map();

    function addChild(parent, item) {
      if (!childMap.has(parent)) childMap.set(parent, []);
      childMap.get(parent).push(item);
    }

    rows.forEach((row) => {
      const label = memberLabel(row);
      const nameKey = row.objectClass === 'group' ? (row.Name || row.SamAccountName) : null;
      const item = { label, nameKey };

      if (!nested || row.Depth === 1) {
        addChild(rootGroup, item);
        return;
      }

      if (row.ViaGroup) {
        const parent = row.ViaGroup.split('>').map((part) => part.trim()).filter(Boolean).pop();
        addChild(parent || rootGroup, item);
        return;
      }

      addChild(rootGroup, item);
    });

    const lines = ['mindmap', `  root((${escapeMermaidLabel(rootGroup)}))`];

    function emitChildren(parentKey, depth) {
      const kids = childMap.get(parentKey) || [];
      kids.forEach((kid) => {
        lines.push(`${' '.repeat(2 + depth * 2)}${escapeMermaidLabel(kid.label)}`);
        if (kid.nameKey && childMap.has(kid.nameKey)) {
          emitChildren(kid.nameKey, depth + 1);
        }
      });
    }

    emitChildren(rootGroup, 0);
    return lines.join('\n');
  }

  window.MembershipDiagram = { extractContext, toMermaid };
})();
