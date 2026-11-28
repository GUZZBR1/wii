/**
 * Roda `run` só depois que a volta da arena (`body.is-arriving`) termina; fora dela, na hora.
 * Trabalho pesado durante a animação a faz travar. Devolve o cancelamento.
 */
export function afterArrival(run: () => void): () => void {
  if (!document.body.classList.contains('is-arriving')) {
    run();
    return () => {};
  }
  const observer = new MutationObserver(() => {
    if (document.body.classList.contains('is-arriving')) return;
    observer.disconnect();
    run();
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
