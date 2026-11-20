import { useMemo, useState } from 'react';
import { findTreeNode, type TreeNode } from '../core/sceneTree';
import { Icon } from './Icon';

export interface ComponentTreeProps {
  tree: TreeNode;
  hidden: ReadonlySet<string>;
  isolated: string | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onToggleHidden: (id: string) => void;
  onSolo: (id: string | null) => void;
  onClear: () => void;
}

const kindClass = (kind: string): string => {
  if (kind === 'group') return 'group';
  if (kind === 'op') return 'op';
  if (kind === 'paint' || kind === 'offset' || kind === 'shell') return 'mod';
  if (kind === 'implicit') return 'impl';
  if (kind === 'spline' || kind === 'extrude' || kind === 'lathe') return 'spline';
  return 'prim';
};

function countNodes(node: TreeNode): number {
  return 1 + node.children.reduce((n, child) => n + countNodes(child), 0);
}

interface RowProps {
  node: TreeNode;
  hidden: ReadonlySet<string>;
  isolated: string | null;
  selected: string | null;
  collapsed: ReadonlySet<string>;
  parentHidden: boolean;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onSolo: (id: string | null) => void;
}

function Row({
  node,
  hidden,
  isolated,
  selected,
  collapsed,
  parentHidden,
  onToggle,
  onSelect,
  onToggleHidden,
  onSolo,
}: RowProps) {
  const isHidden = hidden.has(node.id);
  const isSolo = isolated === node.id;
  const hasChildren = node.children.length > 0;
  const open = hasChildren && !collapsed.has(node.id);
  const dim = parentHidden || isHidden;

  return (
    <>
      <div
        className={[
          'tree-row',
          selected === node.id ? 'selected' : '',
          dim ? 'is-hidden' : '',
          isSolo ? 'is-solo' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ paddingLeft: 8 + Math.min(node.depth, 14) * 15 }}
        onClick={() => onSelect(node.id)}
      >
        <button
          className={`tree-caret ${open ? 'open' : ''}`}
          disabled={!hasChildren}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node.id);
          }}
          title={open ? 'Collapse' : 'Expand'}
          aria-label={open ? 'Collapse component' : 'Expand component'}
        >
          {hasChildren ? <Icon name="chevron" size={10} /> : null}
        </button>
        <span className={`tree-kind k-${kindClass(node.kind)}`} />
        <span className="tree-label" title={`${node.kind}${node.detail ? ` · ${node.detail}` : ''}`}>
          {node.label}
        </span>
        {node.detail && <span className="tree-detail">{node.detail}</span>}
        <span className="tree-actions">
          <button
            className={`tree-act ${isSolo ? 'on' : ''}`}
            title={isSolo ? 'Show the whole scene' : 'Render only this component'}
            aria-pressed={isSolo}
            onClick={(e) => {
              e.stopPropagation();
              onSolo(isSolo ? null : node.id);
            }}
          >
            <Icon name="target" size={13} />
          </button>
          <button
            className={`tree-act ${isHidden ? 'on' : ''}`}
            title={isHidden ? 'Show component' : 'Hide component'}
            aria-pressed={isHidden}
            onClick={(e) => {
              e.stopPropagation();
              onToggleHidden(node.id);
            }}
          >
            <Icon name={isHidden ? 'eyeOff' : 'eye'} size={13} />
          </button>
        </span>
      </div>

      {open &&
        node.children.map((child) => (
          <Row
            key={child.id}
            node={child}
            hidden={hidden}
            isolated={isolated}
            selected={selected}
            collapsed={collapsed}
            parentHidden={dim}
            onToggle={onToggle}
            onSelect={onSelect}
            onToggleHidden={onToggleHidden}
            onSolo={onSolo}
          />
        ))}
    </>
  );
}

export function ComponentTree({
  tree,
  hidden,
  isolated,
  selected,
  onSelect,
  onToggleHidden,
  onSolo,
  onClear,
}: ComponentTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const total = useMemo(() => countNodes(tree), [tree]);
  const soloLabel = isolated ? findTreeNode(tree, isolated)?.label : null;
  const filtersActive = hidden.size > 0 || !!isolated;

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="tree-panel">
      <div className="tree-head">
        <span className="dock-title">components</span>
        <span className="dock-count">{total}</span>
        {filtersActive && (
          <span className="tree-filter-note">
            {isolated ? `solo ${soloLabel ?? ''}` : ''}
            {isolated && hidden.size ? ' · ' : ''}
            {hidden.size ? `${hidden.size} hidden` : ''}
          </span>
        )}
        <span className="grow" />
        {filtersActive && (
          <button className="ghostbtn" onClick={onClear} title="Clear visibility and solo filters">
            <Icon name="reset" size={12} /> clear
          </button>
        )}
      </div>

      <div className="tree-body">
        <Row
          node={tree}
          hidden={hidden}
          isolated={isolated}
          selected={selected}
          collapsed={collapsed}
          parentHidden={false}
          onToggle={toggle}
          onSelect={onSelect}
          onToggleHidden={onToggleHidden}
          onSolo={onSolo}
        />
        <div className="tree-foot">
          <span>
            <Icon name="eye" size={11} /> hide
          </span>
          <span>
            <Icon name="target" size={11} /> solo (render this component only, in place)
          </span>
        </div>
      </div>
    </div>
  );
}
