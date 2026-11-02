/** Joplin desktop 3.7.21, read-only app.asar inspection:
 * services/plugins/UserWebviewIndex.html and UserWebviewIndex.js.
 * setHtml inserts a fragment inside both wrappers; it does not replace document.
 */
export const hostPanelStyle = 'html{overflow:hidden}body{box-sizing:border-box;padding:0;margin:0}#joplin-plugin-content{display:flex;flex-direction:column}';
export const hostPanelFragment = '<div id="joplin-plugin-content-root"><div id="joplin-plugin-content"><div id="root" lang="zh-CN"></div></div></div>';
