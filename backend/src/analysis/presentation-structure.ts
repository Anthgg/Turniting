/** Optional persisted layout hints. Never infer a paragraph kind from inference granularity. */
export function presentationStructureHint(
  metadata: unknown,
  segment: { paragraphIndex: number; textHash: string; charStart: number; charEnd: number },
): { kind?: string; structuralType?: string; structuralGroupId?: string } {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const hints = (metadata as Record<string, unknown>).presentationStructureHints;
  if (!hints || typeof hints !== 'object' || Array.isArray(hints)) return {};
  const value = (hints as Record<string, unknown>)[String(segment.paragraphIndex)];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const hint = value as Record<string, unknown>;
  if (hint.textHash !== segment.textHash || hint.charStart !== segment.charStart || hint.charEnd !== segment.charEnd) return {};
  const allowed = ['BODY', 'PARAGRAPH', 'TABLE', 'TABLE_CELL', 'METADATA', 'CAPTION', 'HEADING', 'REFERENCE_SECTION', 'ANNEX_SECTION'];
  const kind = typeof hint.kind === 'string' && allowed.includes(hint.kind) ? hint.kind : undefined;
  const structuralType = typeof hint.structuralType === 'string' && allowed.includes(hint.structuralType) ? hint.structuralType : undefined;
  const structuralGroupId = typeof hint.structuralGroupId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/u.test(hint.structuralGroupId) ? hint.structuralGroupId : undefined;
  return { ...(kind ? { kind } : {}), ...(structuralType ? { structuralType } : {}), ...(structuralGroupId ? { structuralGroupId } : {}) };
}
