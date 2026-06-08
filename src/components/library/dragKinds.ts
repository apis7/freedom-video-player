/**
 * Custom MIME types used by FVP's intra-app drag-and-drop. Picking a
 * specific media type (instead of just "text/plain") means non-library
 * drop targets (file uploaders, external apps) ignore our payloads and
 * we won't accidentally interpret an external drag as a library drag.
 */
export const FVP_DRAG_IDENTITIES = "application/x-fvp-identities";
export const FVP_DRAG_SIDEBAR_REORDER = "application/x-fvp-sidebar-reorder";
export const FVP_DRAG_GROUP_ITEM_REORDER = "application/x-fvp-group-item-reorder";

export interface SidebarReorderPayload {
  kind: "collection" | "series";
  id: number;
}

export function setSidebarReorderData(
  dt: DataTransfer,
  payload: SidebarReorderPayload,
): void {
  dt.setData(FVP_DRAG_SIDEBAR_REORDER, JSON.stringify(payload));
  dt.setData("text/plain", `Reorder ${payload.kind}`);
  dt.effectAllowed = "move";
}

export function getSidebarReorderData(
  dt: DataTransfer,
): SidebarReorderPayload | null {
  const raw = dt.getData(FVP_DRAG_SIDEBAR_REORDER);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as SidebarReorderPayload;
    if (
      (p.kind === "collection" || p.kind === "series") &&
      typeof p.id === "number"
    ) {
      return p;
    }
  } catch {
    // Fall through.
  }
  return null;
}

export interface GroupItemReorderPayload {
  scopeKind: "collection" | "series";
  scopeId: number;
  identityId: number;
}

export function setGroupItemReorderData(
  dt: DataTransfer,
  payload: GroupItemReorderPayload,
): void {
  dt.setData(FVP_DRAG_GROUP_ITEM_REORDER, JSON.stringify(payload));
  dt.setData("text/plain", `Reorder item in ${payload.scopeKind}`);
  dt.effectAllowed = "move";
}

export function getGroupItemReorderData(
  dt: DataTransfer,
): GroupItemReorderPayload | null {
  const raw = dt.getData(FVP_DRAG_GROUP_ITEM_REORDER);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as GroupItemReorderPayload;
    if (
      (p.scopeKind === "collection" || p.scopeKind === "series") &&
      typeof p.scopeId === "number" &&
      typeof p.identityId === "number"
    ) {
      return p;
    }
  } catch {
    // Fall through.
  }
  return null;
}

/** Encode an identity_id list onto a DragEvent's dataTransfer. */
export function setIdentityDragData(
  dt: DataTransfer,
  identityIds: number[],
): void {
  const payload = JSON.stringify(identityIds);
  dt.setData(FVP_DRAG_IDENTITIES, payload);
  // Also set text/plain as a fallback so OS-level "what is being
  // dragged?" widgets show something sensible if the drag escapes the
  // app boundary.
  dt.setData("text/plain", `${identityIds.length} library item(s)`);
  dt.effectAllowed = "copy";
}

/** Read identity_ids from a DragEvent's dataTransfer. Returns null when
 *  the payload isn't an FVP drag. */
export function getIdentityDragData(dt: DataTransfer): number[] | null {
  const raw = dt.getData(FVP_DRAG_IDENTITIES);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((x) => typeof x === "number")
    ) {
      return parsed;
    }
  } catch {
    // Fall through.
  }
  return null;
}
