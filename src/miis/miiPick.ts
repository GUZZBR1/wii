/**
 * Hand-cursor channel for the plaza picker. Miis move on a click-through canvas and are selected
 * by coordinates rather than DOM targets: the plaza registers the picker, and the hand cursor
 * forwards pinches that did not hit a control. Without a mounted plaza (in the arena), forwarding does nothing.
 */
export type MiiPicker = (x: number, y: number, hit: Element | undefined) => void;

let picker: MiiPicker | null = null;

export function registerMiiPicker(next: MiiPicker): () => void {
  picker = next;
  return () => {
    if (picker === next) picker = null;
  };
}

export function pickMiiAt(x: number, y: number, hit: Element | undefined): void {
  picker?.(x, y, hit);
}
