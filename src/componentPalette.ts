// Static list of common UI component types, offered as quick-pick suggestions
// in the Placement popup. Not exhaustive by design — the componentType field
// stays a free-text input (via <datalist>), so anything not in this list can
// still be typed manually.
export const COMPONENT_PALETTE: readonly string[] = [
  'Button',
  'Card',
  'Input',
  'Modal',
  'Table',
  'Badge',
  'Avatar',
  'Tabs',
  'Accordion',
  'Tooltip',
  'Dropdown',
  'Toast',
  'Progress bar',
  'Slider',
  'Checkbox',
  'Radio',
  'Switch',
  'Breadcrumb',
  'Pagination',
  'Skeleton',
];
