// What the right panel shows outside a page: the document selected in the inbox
// (the inspector is never passive, it previews the active element).
class InspectState {
  /** Source selected in the inbox of a tab, by tab id. */
  sourceByTab = $state<Record<string, string | null>>({});
  /**
   * Grows when the panel changes a source the lists cannot see change (reviewed, deleted,
   * replaced): the inbox reads its list again. `selectNext` is the source to show next.
   */
  changed = $state(0);
  selectNext = $state<string | null | undefined>(undefined);
  touch(next?: string | null): void {
    this.selectNext = next;
    this.changed++;
  }
}
export const inspect = new InspectState();
