import type { Annotation, OutputFormat } from './types';

function line(label: string, value?: string | number | boolean): string | null {
  if (value === undefined || value === null || value === '') return null;
  return `**${label}:** ${value}`;
}

export function formatAnnotation(
  a: Annotation,
  index: number,
  format: OutputFormat = 'standard'
): string {
  const lines: (string | null)[] = [];

  if (a.kind === 'placement') {
    return formatPlacement(a, index, format);
  }
  if (a.kind === 'rearrange') {
    return formatRearrange(a, index, format);
  }
  if (a.kind === 'area') {
    return formatArea(a, index, format);
  }

  lines.push(`## Annotation #${index}`);

  const firstClass = a.cssClasses?.split(' ').filter(Boolean)[0];
  const elementLabel = firstClass ? `${a.element}.${firstClass}` : a.element;

  lines.push(line('Element', elementLabel));
  lines.push(line('Path', format === 'forensic' && a.fullPath ? a.fullPath : a.elementPath));

  if (format !== 'compact' && a.reactComponents) {
    lines.push(line('Vue', a.reactComponents));
  }

  if (a.isMultiSelect && format !== 'compact') {
    lines.push(line('Multi-select', 'true'));
    lines.push(line('Nearby elements', a.nearbyElements));
  }

  if (format === 'standard' || format === 'detailed' || format === 'forensic') {
    lines.push(line('Classes', a.cssClasses));
  }

  if (a.boundingBox && !a.isMultiSelect) {
    const b = a.boundingBox;
    lines.push(line('Position', `${b.x}px, ${b.y}px (${b.width}×${b.height}px)`));
  }

  if (a.selectedText && format !== 'compact') {
    lines.push(line('Selected text', a.selectedText));
  }

  if (format === 'detailed' || format === 'forensic') {
    lines.push(line('Nearby text', a.nearbyText));
  }

  if (format === 'forensic') {
    lines.push(line('Computed styles', a.computedStyles));
    lines.push(line('Accessibility', a.accessibility));
    lines.push(line('URL', a.url));
    lines.push(line('Timestamp', new Date(a.timestamp).toISOString()));
  }

  lines.push(line('Feedback', a.comment));
  lines.push(line('Intent', a.intent));
  lines.push(line('Severity', a.severity));
  if (format === 'forensic') lines.push(line('Status', a.status));

  return lines.filter((l): l is string => l !== null).join('\n');
}

function formatPlacement(a: Annotation, index: number, format: OutputFormat): string {
  const lines: (string | null)[] = [`## Annotation #${index} (Placement)`];
  const p = a.placement;

  lines.push(line('Component type', p?.componentType));
  if (p) {
    lines.push(line('Proposed size', p.width && p.height ? `${p.width}×${p.height}px` : undefined));
    lines.push(line('Scroll position', `${p.scrollY}px`));
    if (p.text) lines.push(line('Suggested text', p.text));
  }

  lines.push(line('Feedback', a.comment));
  lines.push(line('Intent', a.intent));
  if (format !== 'compact') {
    lines.push(line('Position', a.boundingBox ? `${a.x}%, ${a.y}px` : undefined));
  }

  return lines.filter((l): l is string => l !== null).join('\n');
}

function formatRearrange(a: Annotation, index: number, _format: OutputFormat): string {
  const lines: (string | null)[] = [`## Annotation #${index} (Rearrange)`];
  const r = a.rearrange;

  if (r) {
    lines.push(line('Element', r.label));
    lines.push(line('Selector', r.selector));
    lines.push(
      line(
        'Original position',
        `${r.originalRect.x}px, ${r.originalRect.y}px (${r.originalRect.width}×${r.originalRect.height}px)`
      )
    );
    lines.push(
      line(
        'Proposed position',
        `${r.currentRect.x}px, ${r.currentRect.y}px (${r.currentRect.width}×${r.currentRect.height}px)`
      )
    );
  }

  lines.push(line('Feedback', a.comment));
  lines.push(line('Intent', a.intent));
  lines.push(line('Severity', a.severity));

  return lines.filter((l): l is string => l !== null).join('\n');
}

function formatArea(a: Annotation, index: number, format: OutputFormat): string {
  const lines: (string | null)[] = [`## Annotation #${index} (Area)`];
  const area = a.area;

  if (area) {
    lines.push(
      line(
        'Region',
        `${area.rect.x}px, ${area.rect.y}px (${area.rect.width}×${area.rect.height}px)`
      )
    );
    lines.push(line('Scroll position', `${area.scrollY}px`));
  }

  if (format !== 'compact') {
    lines.push(line('Position (relative)', a.boundingBox ? `${a.x}%, ${a.y}px` : undefined));
    if (a.url) lines.push(line('URL', a.url));
  }

  lines.push(line('Feedback', a.comment));
  lines.push(line('Intent', a.intent));
  lines.push(line('Severity', a.severity));

  return lines.filter((l): l is string => l !== null).join('\n');
}

export function serializeAnnotations(
  annotations: Annotation[],
  format: OutputFormat = 'standard'
): string {
  return annotations.map((a, i) => formatAnnotation(a, i + 1, format)).join('\n\n');
}
