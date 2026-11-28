/**
 * Canal do cursor de mão para o picker da praça. Os Miis andam num canvas click-through e são
 * escolhidos por coordenadas, não por alvo DOM: a praça registra o picker e a mão repassa as
 * pinças que não caíram em controle nenhum. Sem praça montada (arena), o repasse não faz nada.
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
