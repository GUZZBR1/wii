/**
 * Run `run` only after the return transition from the arena (`body.is-arriving`) finishes; run it immediately elsewhere.
 * Heavy work during the animation causes stutter. Return a cancellation function.
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
