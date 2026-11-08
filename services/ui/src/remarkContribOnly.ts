// Remark plugin: contrib elements only, the rest as typed.

interface Point {
  offset?: number;
}

interface MdNode {
  type: string;
  value?: string;
  data?: { hName?: string };
  position?: { start: Point; end: Point };
  children?: MdNode[];
}

export default function remarkContribOnly(opts: { tags: readonly string[] }) {
  const tags = new Set(opts.tags);
  return (tree: MdNode, file: { value: unknown }) => {
    const src = String(file.value);
    const kept: MdNode[] = [];
    const walk = (node: MdNode) => {
      const at = node.position;
      if (node.data?.hName && tags.has(node.data.hName) && at?.start.offset !== undefined && at.end.offset !== undefined) {
        kept.push(node);
        return;
      }
      node.children?.forEach(walk);
    };
    walk(tree);
    const children: MdNode[] = [];
    let from = 0;
    for (const node of kept) {
      const start = node.position!.start.offset!;
      if (start > from) children.push({ type: "text", value: src.slice(from, start) });
      children.push(node);
      from = node.position!.end.offset!;
    }
    if (from < src.length) children.push({ type: "text", value: src.slice(from) });
    tree.children = [{ type: "paragraph", children }];
  };
}
