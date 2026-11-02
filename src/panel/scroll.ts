/** Keep the viewport scroll position while a fixed drawer owns scrolling. */
export function lockPanelScroll(root: HTMLElement | null): () => void {
  if (!root) return () => {};
  const overflow = root.style.overflowY;
  const position = root.scrollTop;
  root.style.overflowY = 'hidden';
  return () => {
    root.style.overflowY = overflow;
    root.scrollTop = position;
  };
}
