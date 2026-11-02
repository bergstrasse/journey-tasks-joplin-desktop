import { stripBodyTemplate } from './body-template';

/** Compare execution text while retaining all user Markdown and checkbox states. */
export function withoutAnchorNotice(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  return stripBodyTemplate(body.replace(/\n{0,2}<!-- journey-series-anchor:v2 -->[\s\S]*?<!-- \/journey-series-anchor:v2 -->\n?/g, ''));
}
