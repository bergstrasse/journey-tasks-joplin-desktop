declare module 'react-dom/client' {
  import type { ReactNode } from 'react';
  export interface Root { render(children: ReactNode): void; unmount(): void }
  export function createRoot(container: Element | DocumentFragment): Root;
}
declare module 'react-dom/server' {
  import type { ReactNode } from 'react';
  export function renderToStaticMarkup(children: ReactNode): string;
}
