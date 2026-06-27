// src/index.ts
export { default as TianAnnotate } from './TianAnnotate.vue';

export * from './types';
export { formatAnnotation, serializeAnnotations } from './markdown';
export { useTianAnnotateStore } from './store';

export {
  describeElement,
  getElementPath,
  getFullPath,
  getCssClasses,
  getBoundingBox,
  getComputedStylesSummary,
  getNearbyText,
  getAccessibilitySummary,
  isFixedOrSticky,
  getElementsInRect,
  getMeaningfulTarget,
  getUnionRect,
} from './dom';

export { getVueInstance, getComponentTree, getSourceFile } from './vueTree';
